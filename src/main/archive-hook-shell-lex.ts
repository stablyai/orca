import { quotePosixShell } from '../shared/wsl-login-shell-command'

export type ArchiveHookShell = 'posix' | 'cmd'

export type ArchiveHookWord = { start: number; end: number; text: string; unsafe: boolean }

type Heredoc = { delimiter: string; stripTabs: boolean }

/**
 * cmd sees this unquoted. Node's local shell wrap and the relay's argv quoting each add one
 * pair that `/s` strips, and an inner quote is turned into a backslash on that relay hop.
 * A caret before `%` stops that one parse from expanding it. `%%` would survive `cmd /c`.
 */
function quoteForCmd(value: string): string {
  return value.replace(/[ \t&|()<>^%]/g, (char) => `^${char}`)
}

export function quoteArchiveHookShell(value: string, shell: ArchiveHookShell): string {
  if (shell === 'cmd') {
    return quoteForCmd(value)
  }
  return quotePosixShell(value)
}

function heredocAt(source: string): Heredoc | null {
  const match = source.match(/^<<(-)?\s*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z0-9_]+))/)
  if (!match) {
    return null
  }
  const delimiter = match[2] ?? match[3] ?? match[4]
  if (delimiter == null) {
    return null
  }
  return { delimiter, stripTabs: match[1] === '-' }
}

/** Heredoc opener in shell code. A `<<` in a comment or quotes is not one. */
export function archiveHookHeredocDelimiter(line: string): Heredoc | null {
  let index = 0
  let quote: '"' | "'" | null = null
  while (index < line.length) {
    const char = line[index]
    if (quote) {
      if (quote === '"' && char === '\\' && index + 1 < line.length) {
        index += 2
        continue
      }
      if (char === quote) {
        quote = null
      }
      index += 1
      continue
    }
    if (char === '\\' && index + 1 < line.length) {
      index += 2
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      index += 1
      continue
    }
    if (char === '#') {
      break
    }
    if (char === '<' && line[index + 1] === '<') {
      const found = heredocAt(line.slice(index))
      if (found) {
        return found
      }
    }
    index += 1
  }
  return null
}

/** The next word is a redirect operand, so it has to stay in the worktree. */
export function archiveHookRedirectsNextWord(word: string): boolean {
  return /(?:&>>|&>>?|>&|\d*>>?|\d*>\||\d*<>|\d*<|<<-|<<<|<<)$/.test(word)
}

export function archiveHookHeredocClosed(line: string, heredoc: Heredoc): boolean {
  const closer = heredoc.stripTabs ? line.replace(/^\t+/, '') : line
  return closer === heredoc.delimiter
}

export function scanArchiveHookWords(line: string, shell: ArchiveHookShell): ArchiveHookWord[] {
  const words: ArchiveHookWord[] = []
  let index = 0
  while (index < line.length) {
    while (index < line.length && /\s/.test(line[index])) {
      index += 1
    }
    if (index >= line.length) {
      break
    }
    if (shell === 'posix' && line[index] === '#') {
      break
    }
    const start = index
    let text = ''
    let unsafe = false
    let quote: '"' | "'" | null = null
    while (index < line.length) {
      const char = line[index]
      if (quote === "'") {
        if (char === "'") {
          quote = null
          index += 1
          continue
        }
        text += char
        index += 1
        continue
      }
      if (quote === '"') {
        if (char === '\\' && index + 1 < line.length) {
          const next = line[index + 1]
          if (next === '$' || next === '`' || next === '"' || next === '\\') {
            if (next === '$' || next === '`') {
              unsafe = true
            }
            text += next
            index += 2
            continue
          }
        }
        if (char === '"') {
          quote = null
          index += 1
          continue
        }
        if (char === '$' || char === '`') {
          unsafe = true
        }
        text += char
        index += 1
        continue
      }
      if (shell === 'posix' && char === '\\' && index + 1 < line.length) {
        text += line[index + 1]
        index += 2
        continue
      }
      if (char === "'" || char === '"') {
        quote = char
        index += 1
        continue
      }
      if (/\s/.test(char)) {
        break
      }
      if (
        char === '$' ||
        char === '`' ||
        char === '*' ||
        char === '?' ||
        char === '[' ||
        char === '~'
      ) {
        unsafe = true
      }
      text += char
      index += 1
    }
    if (quote) {
      unsafe = true
    }
    words.push({ start, end: index, text, unsafe })
  }
  return words
}
