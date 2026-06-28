// Basic single-pass syntax highlighting for the file editor. Emits SGR color
// directly (so it shows regardless of the no-color theme); the viewport clips
// these lines ANSI-aware. Per-line only — no multi-line string/comment state.
const RESET = '\x1b[0m'
const COMMENT = '\x1b[2m' // dim
const STRING = '\x1b[32m' // green
const NUMBER = '\x1b[33m' // yellow
const KEYWORD = '\x1b[35m' // magenta
const LITERAL = '\x1b[36m' // cyan (true/false/null/…)

// One broad keyword set covers the common languages we open; precise per-language
// sets aren't worth the upkeep for a read/edit view.
const KEYWORDS = new Set([
  'import',
  'export',
  'from',
  'as',
  'default',
  'const',
  'let',
  'var',
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'class',
  'extends',
  'implements',
  'interface',
  'type',
  'enum',
  'new',
  'this',
  'super',
  'async',
  'await',
  'yield',
  'try',
  'catch',
  'finally',
  'throw',
  'typeof',
  'instanceof',
  'in',
  'of',
  'void',
  'delete',
  'public',
  'private',
  'protected',
  'readonly',
  'static',
  'def',
  'elif',
  'lambda',
  'pass',
  'with',
  'fn',
  'let',
  'mut',
  'pub',
  'use',
  'struct',
  'impl',
  'match',
  'func',
  'package',
  'go',
  'defer',
  'range',
  'map',
  'and',
  'or',
  'not'
])
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'nil'])

const HASH_COMMENT = new Set(['py', 'sh', 'bash', 'zsh', 'rb', 'yml', 'yaml', 'toml', 'conf'])
const NO_HIGHLIGHT = new Set(['', 'txt', 'md', 'markdown', 'json', 'log', 'csv'])

/** Map a path to a language key (its extension), or 'plain' when not code. */
export function languageFromPath(path: string | null): string {
  const ext = (path ?? '').split('.').pop()?.toLowerCase() ?? ''
  return NO_HIGHLIGHT.has(ext) ? 'plain' : ext
}

function isWord(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch)
}

/** Color a single source line for `lang` ('plain' returns it unchanged). */
export function highlightLine(line: string, lang: string): string {
  if (lang === 'plain') {
    return line
  }
  const commentMark = HASH_COMMENT.has(lang) ? '#' : '//'
  let out = ''
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (line.startsWith(commentMark, i)) {
      return `${out}${COMMENT}${line.slice(i)}${RESET}`
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = stringEnd(line, i, ch)
      out += `${STRING}${line.slice(i, end)}${RESET}`
      i = end
      continue
    }
    if (ch >= '0' && ch <= '9') {
      let j = i
      while (j < line.length && /[0-9._a-fxA-FX]/.test(line[j])) {
        j += 1
      }
      out += `${NUMBER}${line.slice(i, j)}${RESET}`
      i = j
      continue
    }
    if (isWord(ch)) {
      let j = i
      while (j < line.length && isWord(line[j])) {
        j += 1
      }
      const word = line.slice(i, j)
      const color = KEYWORDS.has(word) ? KEYWORD : LITERALS.has(word) ? LITERAL : ''
      out += color ? `${color}${word}${RESET}` : word
      i = j
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** Index just past the closing quote of a string starting at `start`, honoring
 *  backslash escapes; the end of line when unterminated. */
function stringEnd(line: string, start: number, quote: string): number {
  let i = start + 1
  while (i < line.length) {
    if (line[i] === '\\') {
      i += 2
      continue
    }
    if (line[i] === quote) {
      return i + 1
    }
    i += 1
  }
  return line.length
}
