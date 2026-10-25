// One-pass tokenization for the resume guard’s limited shell syntax.

const BLANKS = /[^\S\r\n]+/y
// Unquoted text, or a redirection: `>&`, `<&` and `&>` do not end a command.
const WORD_PIECE = /[^\s&|;"'<>]+|[<>]&|&>|[<>]/y
const SEPARATOR = /&&|\|\||[&|;]|\r\n|\r|\n/y
const LINE_BREAKS = new Set(['\r\n', '\r', '\n'])
// POSIX `\`, PowerShell `` ` `` and cmd `^` before a line break continue the command.
const CONTINUATION_MARKS = new Set(['\\', '`', '^'])

type ShellToken = { word: string; continuesLine: boolean } | { separator: string }

/** Split commands into unquoted words, including separators glued to words such as cd /x&&claude. */
export function* shellCommands(text: string): Generator<string[]> {
  let words: string[] = []
  let continuesLine = false
  for (const token of shellTokens(text)) {
    if ('word' in token) {
      words.push(token.word)
      continuesLine = token.continuesLine
      continue
    }
    if (continuesLine && LINE_BREAKS.has(token.separator)) {
      const continued = words.pop()!.slice(0, -1)
      if (continued) {
        words.push(continued)
      }
    } else if (words.length > 0) {
      yield words
      words = []
    }
    continuesLine = false
  }
  if (words.length > 0) {
    yield words
  }
}

function* shellTokens(text: string): Generator<ShellToken> {
  // Once a quote of a kind has no closing quote, no later one of that kind has either.
  const unclosedFrom = { '"': text.length, "'": text.length }
  let index = 0
  while (index < text.length) {
    BLANKS.lastIndex = index
    if (BLANKS.test(text)) {
      index = BLANKS.lastIndex
      continue
    }
    // A word joins unquoted text and quoted runs: `--session="a b"` is one word.
    const pieces: string[] = []
    let continuesLine = false
    while (index < text.length) {
      WORD_PIECE.lastIndex = index
      const quote = text[index]
      if (WORD_PIECE.test(text)) {
        pieces.push(text.slice(index, WORD_PIECE.lastIndex))
        index = WORD_PIECE.lastIndex
        continuesLine = CONTINUATION_MARKS.has(text[index - 1]!)
      } else if (quote === '"' || quote === "'") {
        const close = index < unclosedFrom[quote] ? closingQuote(text, index) : -1
        if (close === -1) {
          unclosedFrom[quote] = index
        }
        pieces.push(close === -1 ? quote : text.slice(index + 1, close))
        continuesLine = false
        index = close === -1 ? index + 1 : close + 1
      } else {
        break
      }
    }
    if (pieces.length > 0) {
      yield { word: pieces.length === 1 ? pieces[0]! : pieces.join(''), continuesLine }
      continue
    }
    SEPARATOR.lastIndex = index
    const separator = SEPARATOR.exec(text)![0]
    yield { separator }
    index += separator.length
  }
}

function closingQuote(text: string, open: number): number {
  const quote = text[open]!
  for (let at = text.indexOf(quote, open + 1); at !== -1; at = text.indexOf(quote, at + 1)) {
    let backslashes = 0
    while (quote === '"' && text[at - 1 - backslashes] === '\\') {
      backslashes += 1
    }
    if (backslashes % 2 === 0) {
      return at
    }
  }
  return -1
}

export function commandName(word: string): string {
  return word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1).toLowerCase()
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const LAUNCHERS = new Set([
  'env',
  'exec',
  'command',
  'sudo',
  'nohup',
  'time',
  'npx',
  'bunx',
  'wsl',
  'wsl.exe'
])

/** Skip environment assignments and known launchers to find the program; return -1 if absent. */
export function commandProgramIndex(words: readonly string[]): number {
  let launched = false
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!
    if (ASSIGNMENT.test(word) || (launched && word.startsWith('-'))) {
      continue
    }
    const name = commandName(word)
    if (name === 'pnpm' && words[index + 1] === 'dlx') {
      index += 1
    } else if (!LAUNCHERS.has(name)) {
      return index
    }
    launched = true
  }
  return -1
}
