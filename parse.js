'use strict';

const GLOBSTAR_DOT = '(?:(?!(?:\\/|^)(?:\\.{1,2})($|\\/)).)*?';
const GLOBSTAR_NO_DOT = '(?:(?!(?:\\/|^)\\.).)*?';
const QMARK_NO_DOT = '[^/.]';
const QMARK = '[^/]';
const STAR = `${QMARK}*?`;
const NO_DOT = '(?!\\.)';
const ONE_CHAR = '(?=.)';
const MAX_LENGTH = 1024 * 64;
const scan = require('./scanner');

module.exports = (input, options = {}) => {
  let max = (options.maxLength) || MAX_LENGTH;

  if (typeof input !== 'string') {
    throw new TypeError('expected input to be a string');
  }

  if (input.length > max) {
    throw new RangeError(`input string must not be longer than ${max} bytes`);
  }

  const ast = { type: 'root', nodes: [], stash: [] };
  let state = { input, ast, wrap: str => `^${str}$` };
  let prepend = options.prepend || '';
  let stack = [ast];
  let extglobs = [];
  let orig = input;
  let i = -1;

  let after, args, block, boundary, brace, bracket, charClass, dots, idx, inner, left, match, next, node, noglobstar, paren, prev, qmark, quoted, star, stars, value;

  if (input.startsWith('./')) {
    input = input.slice(2);
    state.prefix = './';
  }

  if (input === '**/**' || input === '**/**/**') {
    input = '**';
  }

  if (options.nonegate !== true && input[0] === '!' && (input[1] !== '(' || input[2] === '?')) {
    state.wrap = str => `^(?!^${str}$).*$`;
    state.negated = true;
    input = input.slice(1);
  }

  state.dot = options.dot === true || input[0] === '.';

  let { base = [], glob } = scan(input)

  if (typeof options.base === 'string') {
    base = options.base.split(/[\\/]+/).concat(base);
  }

  if (base.length && glob) {
    ast.stash = [base.join('\\/') + '\\/'];
    input = glob;

    if (options.dot !== true && input[0] !== '.') {
      ast.stash.push(NO_DOT);
    }
  }

  const append = (value, node) => {
    block.stash.push(value);
    if (node && block.nodes) {
      block.nodes.push(node);
      Reflect.defineProperty(node, 'parent', { value: block });
    }
  };

  const isSpecialChar = ch => {
    return typeof ch === 'string' && ch !== '' && /^["`'$()*+-.?\\[\]^{|}]$/.test(ch);
  };

  const lookbehind = (n = 1) => stack[stack.length - n];
  const rest = () => input.slice(i + 1);
  const peek = (n = 1) => input[i + n];
  const advance = () => input[++i];
  const eos = () => i === input.length - 1;

  const extglob = value => {
    if (options.noextglob === true) {
      block.stash.push(value);
      return;
    }
    state.wildcard = true;
    paren = options.capture === true ? '(' : '(?:';
    node = { type: 'paren', extglob: true, prefix: value, stash: [], nodes: [] };
    node.stash = value === '!' ? [`${paren}(?!(?:`] : [paren];
    Reflect.defineProperty(node, 'parent', { value: block });
    block.nodes.push(node);
    extglobs.push(node);
    stack.push(node);
    advance();
  };

  while (i < input.length - 1) {
    value = advance();
    next = peek();
    block = lookbehind(1);

    if (value === '\\') {
      if (options.bash === true) {
        append(!isSpecialChar(next) ? '\\\\' : '');
      } else {
        append((options.unescape ? '' : '\\') + advance());
      }
      state.prev = value;
      continue;
    }

    if (block.type === 'quote' && value !== '"' && value !== "'" && value !== '`') {
      state.prev = value;
      append(isSpecialChar(value) ? `\\${value}` : value);
      continue;
    }

    if (block.type === 'bracket' && value !== ']') {
      state.prev = value;
      append(value);
      continue;
    }

    switch (value) {
      case '[':
        state.wildcard = true;
        node = { type: 'bracket', stash: [value], nodes: [] };
        if (peek() === ']') node.stash.push(`\\${advance()}`);
        stack.push(node);
        break;
      case ']':
        if (block.type !== 'bracket') {
          append('\\]');
          break;
        }

        bracket = stack.pop();
        block = lookbehind(1);
        if (bracket.stash[1] === '^' && !bracket.stash.includes('/') && next !== void 0) {
          bracket.stash.push('/');
        }

        inner = bracket.stash.slice(1).join('');
        left = inner.replace(/\W/g, '\\$&');
        append(`(?:\\[${left}\\]|[${inner}])`);
        break;
      case '(':
        if (!/\)/.test(rest())) {
          if (options.strictErrors === true) {
            throw new Error('Missing closing: ")" - use "\\\\)" to match literal closing parentheses');
          }
          append('\\(');
          break;
        }
        node = { type: 'paren', stash: [value], nodes: [] };
        block.nodes.push(node);
        stack.push(node);
        break;
      case ')':
        if (lookbehind(1).type !== 'paren') {
          if (options.strictErrors === true) {
            throw new Error('Missing opening: "(" - use "\\\\(" to match literal opening parentheses');
          }
          append('\\)');
          break;
        }

        paren = stack.pop();
        inner = paren.stash.join('');
        block = lookbehind(1);

        if (paren.prefix) {
          state.wildcard = true;
          boundary = eos() || (/^\)/.test(rest()) && block.prefix !== '!') ? '$' : '';
          extglobs.pop();

          if (block.close === false) {
            append(inner);
            break;
          }
        }

        switch (paren.prefix) {
          case '!':
            star = (options.bash || paren.stash.includes('\\/') || paren.nodes.length) ? '.*?' : STAR;
            append(`${inner})${boundary})${star})`);
            break;
          case '*':
          case '+':
          case '?':
            append(`${inner})${paren.prefix}`);
            break;
          case '@':
          default: {
            append(`${inner})`);
            break;
          }
        }
        break;
      case '{':
        state.wildcard = true;
        node = { type: 'brace', stash: [value], nodes: [] };
        block.nodes.push(node);
        stack.push(node);
        break;
      case '}':
        if (block.type !== 'brace') {
          append('\\}');
          break;
        }

        brace = stack.pop();
        block = lookbehind(1);

        if (brace.quantifier === true) {
          append(`{${brace.stash.slice(1).join('')}}`);
          break;
        }

        if (typeof options.expandBrace === 'function') {
          brace.stash.push('}');
          append(options.expandBrace(...brace.stash));
          break;
        }

        if (brace.stash.includes('..')) {
          inner = brace.stash.filter(v => v !== '{');
          dots = inner.indexOf('..');
          args = [inner.slice(0, dots).join(''), inner.slice(dots + 1).join('')];

          if (typeof options.expandRange === 'function') {
            append(options.expandRange(...args));
            break;
          }

          charClass = `[${args.join('-')}]`;
          try {
            /* eslint-disable no-new */
            new RegExp(charClass);
          } catch (ex) {
            charClass = `[${args.map(v => `\\${v}`).join('-')}]`;
          }

          append(charClass);
          break;
        }

        append('(' + brace.stash.slice(1).join('') + ')');
        break;
      case '!':
        if (next === '(' && peek(2) !== '?') {
          extglob(value);
          break;
        }

        if (i === 0) {
          state.negated = true;
          break;
        }

        append(value);
        break;
      case '*':
        if (next === '(' && peek(2) !== '?') {
          extglob(value);
          break;
        }

        prev = state.prev;
        stars = value;

        while ((next = peek()) === '*') stars += advance();

        noglobstar = options.noglobstar === true
          || (next && next !== '/' && block.type !== 'paren')
          || (prev && prev !== '/' && block.type !== 'paren')
          || stars.length > 2;

        if (noglobstar) stars = '*';
        if (options.dot !== true) {
          if (!state.dot && ((i === 0 && !state.negated) || prev === '/')) {
            idx = Math.max(block.stash.lastIndexOf('\\/'), 0);
            after = block.stash.slice(idx);

            if (!after.includes(NO_DOT)) {
              append(NO_DOT);
            }

            if (stars.length === 1 && !after.includes(ONE_CHAR)) {
              append(ONE_CHAR);
            }
          }
        }

        state.wildcard = true;
        if (stars === '**') {
          state.globstar = true;
          append(options.dot || next === '.' ? GLOBSTAR_DOT : GLOBSTAR_NO_DOT);
          block.nodes.push({ type: 'globstar' });
        } else {
          append(options.bash ? '.*?' : STAR);
        }
        break;
      case '?':
        if (next === '(' && peek(2) !== '?') {
          extglob(value);
          break;
        }

        if (state.prev === '(') {
          match = /^([!=:]|<[!=])/.exec(input.slice(i + 1));
          if (match) {
            if (match[1] === '<!' || match[1] === '<=') {
              let v = process.version;
              if (parseInt(v.slice(1), 10) < 10) {
                throw new Error('Node.js v10 or higher is required for regex lookbehinds');
              }
            }
            append(value);
            break;
          }
        }

        qmark = value;
        while ((next = peek()) === '?') qmark += advance();

        if ((i === 0 || state.prev === '/') && options.dot !== true) {
          append(QMARK_NO_DOT);
        } else {
          append(options.bash ? '.' : QMARK);
        }

        if (qmark.length > 1) {
          append(`{${qmark.length}}`);
        }
        break;
      case '@':
        if (next === '(' && peek(2) !== '?') {
          extglob(value);
          break;
        }

        append(value);
        break;
      case '+':
        if (next === '(' && peek(2) !== '?') {
          extglob(value);
          break;
        }
        if (block.type !== 'paren' && state.prev !== ']' && state.prev !== ')') {
          append('\\');
        }
        append('+');
        break;
      case '/':
        append(`\\${value}`);
        if (options.strictSlashes !== true && !eos() && (input.slice(i - 2, i) === '**' || rest() === '**') && next !== '[' && next !== '(' && isSpecialChar(state.prev)) {
          append('?');
        }

        break;
      case '.':
        if (block.type === 'brace') {
          while ((next = peek()) === '.') value += advance();
          append(value);
          break;
        }

        if ((i === 0 || state.prev === '/' || state.prev === '}' || state.prev === ')')) {
          state.dot = true;
        }
        append('\\.');
        break;
      case ',':
        node = { type: 'comma', value: block.type === 'brace' ? '|' : value };
        append(node.value, node);
        break;
      case '|':
        if (block.type !== 'brace' && block.type !== 'paren') {
          append('\\');
        }
        append('|');
        break;
      case '"':
      case "'":
      case '`':
        if (block.type === 'quote' && block.stash[0] === value) {
          quoted = stack.pop();

          if (options.keepQuotes !== true) {
            quoted.stash = quoted.stash.slice(1);
          } else {
            quoted.stash.push(value);
          }

          block = lookbehind(1);
          append(quoted.stash.join(''));
        } else {
          block = { type: 'quote', stash: [value], nodes: [] };
          stack.push(block);
        }
        break;
      default: {
        node = { type: 'text', value: isSpecialChar(value) ? `\\${value}` : value };
        append(node.value);
        break;
      }
    }
    state.prev = value;
  }

  if (ast.stash[0] !== ONE_CHAR && isSpecialChar(orig[0])) {
    ast.stash.unshift(ONE_CHAR);
  }

  if (options.strictSlashes !== true && !/\/\*?$/.test(orig)) {
    ast.stash.push('\\/?');
  }

  state.base = base;
  state.glob = glob;
  state.output = state.wrap(prepend + ast.stash.join(''));
  // console.log(state);
  return state;
};
