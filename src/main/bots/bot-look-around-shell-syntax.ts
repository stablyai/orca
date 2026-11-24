// How a look-around command reads as shell text: its characters, its chain parts and their words,
// and the shell syntax named when a part isn't plain words.

/** The shell a command runs in: Bash (or Codex's sh wrapper), or Claude's PowerShell tool on Windows. */
export type LookAroundShell = 'bash' | 'powershell'

/** A shell can read nothing else into these: no globs, braces, tildes, history or expansion. */
const PLAIN_WORD = /^[A-Za-z0-9._/:=@,+-]+$/

/** PowerShell reads curly quotes as quotes and these dashes as `-`, so a quoted value could close
 *  early; refused in both shells, since a command string may reach either. */
const CURLY_QUOTE_OR_DASH = /[\u2013-\u201E]/

/** Control and invisible characters a shell or a program may read differently from this check. */
// oxlint-disable-next-line no-control-regex -- these are the characters refused
const INVISIBLE = /[\0-\x08\x0B\x0C\x0E-\x1F\x7F\x85\u2028\u2029\uFEFF]/

/** Why a command's characters can't be checked as written: control or invisible characters, or
 *  PowerShell's curly quotes and dashes. Null when they can. */
export function characterRefusal(command: string): string | null {
  if (INVISIBLE.test(command)) {
    return syntaxRefusal('a control or invisible character')
  }
  const curly = CURLY_QUOTE_OR_DASH.exec(command)
  return curly ? syntaxRefusal(`a curly quote or dash ("${curly[0]}"; use straight ' and -)`) : null
}

/** Strips spaces and tabs only: `trim()` would also take newlines and a BOM the shell still reads. */
export function trimBlanks(text: string): string {
  return text.replace(/^[ \t]+|[ \t]+$/g, '')
}

type Word = { text: string; quoted: boolean }

/**
 * Splits a command into words: plain words, or single-quoted text with no quote inside. Null for
 * anything else, so no shell syntax (piping, redirection, expansion, globs) reaches the checks.
 */
export function words(command: string): Word[] | null {
  const out: Word[] = []
  let consumed = ''
  for (const match of command.matchAll(/(?<=^|[ \t])(?:'([^'\n\r]*)'|([^\s']+))(?=[ \t]|$)/g)) {
    const [whole, quoted, plain] = match
    if (plain !== undefined && (!PLAIN_WORD.test(plain) || plain.startsWith('='))) {
      return null
    }
    out.push(
      quoted === undefined ? { text: plain ?? '', quoted: false } : { text: quoted, quoted: true }
    )
    consumed += whole
  }
  // Anything a word didn't take (a stray quote, a newline) is syntax this check can't read.
  const gaps = (text: string) => text.replace(/[ \t]/g, '')
  return gaps(consumed) === gaps(command) ? out : null
}

/**
 * Splits a command at `;`, `&&` and `||` outside single quotes. Where this misreads the shell's
 * quoting, a part keeps a stray quote and `words` refuses it.
 */
export function chainParts(command: string): string[] {
  const parts: string[] = []
  let start = 0
  let quoted = false
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (char === "'") {
      quoted = !quoted
    } else if (!quoted && (char === ';' || ('&|'.includes(char) && command[index + 1] === char))) {
      parts.push(trimBlanks(command.slice(start, index)))
      index += char === ';' ? 0 : 1
      start = index + 1
    }
  }
  parts.push(trimBlanks(command.slice(start)))
  return parts
}

/** The one redirect a read may end with: stderr into the output, or (Bash) away. */
export const TRAILING_REDIRECT: Record<LookAroundShell, RegExp> = {
  bash: /[ \t]+2>(?:&1|\/dev\/null)$/,
  powershell: /[ \t]+2>&1$/
}

/** Codex wraps commands as `/bin/zsh -lc '<command>'`: a bare shell name or a system shell path,
 *  and nothing else before it, or the prefix could itself run something. */
const SHELL_WRAPPER =
  /^(?:(?:\/usr|\/usr\/local|\/opt\/homebrew)?\/bin\/)?(?:ba|z)?sh[ \t]+-l?c[ \t]+'((?:[^']|'\\'')*)'$/

/** The command a shell wrapper runs, checked whole; anything else unchanged. */
export function unwrapShell(command: string): string {
  const trimmed = trimBlanks(command)
  const wrapped = SHELL_WRAPPER.exec(trimmed)
  return wrapped ? wrapped[1].replace(/'\\''/g, "'") : trimmed
}

/** How a bot's preamble names this session's own CLI on POSIX; Orca seals the variable. */
export const BOT_CLI_PREFIX = '"${ORCA_CLI_COMMAND:-orca}" '

/** Shell syntax a look-around command may not use, named for the refusal, with the matched text or not. */
const SHELL_SYNTAX: readonly (readonly [RegExp, string, boolean])[] = [
  [/\n|\r/, 'a second line', false],
  [/"/, "double quotes (use 'single quotes')", false],
  [/\|/, 'a pipe', true],
  [/\d*(?:>>?|<)(?:&\d*-?)?/, 'a redirect', true],
  [/&/, 'running in the background', true],
  [/\$\(?|`/, 'expansion', true]
]

function syntaxRefusal(what: string): string {
  return `Looking around runs plain reads, chained only with ;, && or || and ending at most in 2>&1: ${what} isn't allowed. Use plain words or 'single quotes'.`
}

/** Names the shell syntax that kept `command` from splitting into plain words. */
export function shellSyntaxRefusal(command: string): string {
  const unquoted = command.replace(/'[^'\n\r]*'/g, "''")
  for (const [pattern, name, show] of SHELL_SYNTAX) {
    const match = pattern.exec(unquoted)
    if (match) {
      return syntaxRefusal(show ? `${name} ("${match[0]}")` : name)
    }
  }
  const word = unquoted.split(/[ \t]+/).find((part) => part && !PLAIN_WORD.test(part))
  return syntaxRefusal(`"${word ?? command}"`)
}

/** Words PowerShell would pass differently from how they read: splatting, arrays, and values
 *  Windows PowerShell 5.1 re-quotes into other arguments. */
export function powerShellWordRefusal(parts: readonly Word[]): string | null {
  for (const { text, quoted } of parts) {
    if (quoted && text.includes('"')) {
      return syntaxRefusal("a double quote inside 'single quotes' in PowerShell")
    }
    if (quoted && (text === '' || text.endsWith('\\'))) {
      return syntaxRefusal(`'${text}' (empty or ending in \\) in PowerShell`)
    }
    if (!quoted && text.startsWith('@')) {
      return syntaxRefusal(`"${text}" (splatting in PowerShell)`)
    }
    if (!quoted && text.includes(',')) {
      return syntaxRefusal(`"${text}" (an array in PowerShell; quote it)`)
    }
  }
  return null
}

/** On Windows a bare name may resolve to a `.cmd` or `.bat` launcher, which cmd.exe re-parses: a
 *  quoted `&`, `|`, `<`, `>` or `^` would reach it as an operator, from PowerShell or Git Bash. */
export function windowsLauncherWordRefusal(parts: readonly Word[]): string | null {
  const operator = parts.find(({ text, quoted }) => quoted && /[&|<>^]/.test(text))
  return operator
    ? syntaxRefusal(`'${operator.text}' (cmd.exe reads & | < > ^ even in quotes on Windows)`)
    : null
}
