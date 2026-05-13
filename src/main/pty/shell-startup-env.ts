import { existsSync, readFileSync } from 'fs'
import { basename, join } from 'path'

// Why: only files the user's actual shell would source. Mixing zsh and bash
// files breaks the "last assignment wins matches the live shell" guarantee —
// a stale .bash_profile on a zsh user would clobber the real .zshrc value.
const ZSH_FILES = ['.zshenv', '.zprofile', '.zshrc', '.zlogin']
// Why: Orca launches bash as a login shell (see local-pty-shell-ready.ts
// getBashShellReadyRcfileContent and daemon/shell-ready.ts) which sources
// .bash_profile / .bash_login / .profile but intentionally does NOT force
// .bashrc. Scanning .bashrc would mirror values the live Orca bash never sees.
const BASH_LOGIN_FILES = ['.bash_profile', '.bash_login', '.profile']

function shellStartupFiles(shell: string | undefined): readonly string[] {
  if (!shell) {
    // Why: Orca's POSIX default shell is /bin/zsh when $SHELL is unset.
    return ZSH_FILES
  }

  const name = basename(shell).toLowerCase()
  if (name === 'zsh') {
    return ZSH_FILES
  }
  if (name === 'bash') {
    return BASH_LOGIN_FILES
  }
  // Why: unsupported explicit shells (fish, nushell, custom wrappers) do not
  // use Orca's zsh/bash shell-ready startup files, so scanning those files
  // would mirror values the live PTY shell never sees.
  return []
}

function unquoteShellValue(value: string): { text: string; quoted: '"' | "'" | null } {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return { text: trimmed.slice(1, -1), quoted: '"' }
    }
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
      return { text: trimmed.slice(1, -1), quoted: "'" }
    }
  }
  return { text: trimmed, quoted: null }
}

function stripTrailingComment(value: string): string {
  // Why: shells only treat `#` as a comment delimiter when it begins a word
  // (unquoted, preceded by whitespace). Walk the string so `#` inside quotes
  // and `path/with#hash` (no preceding whitespace) are preserved literally.
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble
    } else if (ch === '#' && !inSingle && !inDouble) {
      const prev = value[i - 1]
      if (prev === undefined || prev === ' ' || prev === '\t') {
        return value.slice(0, i).trimEnd()
      }
    }
  }
  return value
}

function expandHome(value: string, home: string): string {
  // Why: word boundary on $HOME so $HOMER / $HOMEPATH / $HOME_DIR are NOT
  // partially expanded into a path that doesn't match the live shell.
  return value
    .replace(/^~(?=$|\/)/, home)
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME(?![A-Za-z0-9_])/g, home)
}

const cache = new Map<string, string | undefined>()

/**
 * Best-effort static read of a single env-var assignment from the user's
 * POSIX shell startup files.
 *
 * Why: GUI-launched Orca does not inherit interactive shell exports, but the
 * PTY's startup file will later re-export them and override our overlay. By
 * peeking at the assignment up-front we can preserve the user's source value
 * before installing the overlay.
 *
 * Limits (callers should treat the result as a hint, not authoritative):
 * - Conditionals (`[[ ... ]] && export FOO=...`), sourced files, and
 *   `$VAR` substitution beyond `$HOME` / `${HOME}` / `~` are not evaluated.
 * - Bare assignments (no `export` keyword) are ignored because POSIX shells
 *   do not export them to child processes.
 * - Files are scanned in shell evaluation order for the user's $SHELL family
 *   only (zsh OR bash, not both); unsupported explicit shells scan nothing.
 *   LAST matching assignment wins.
 * - Windows is unsupported (PowerShell profile parsing is out of scope).
 *
 * Results are memoized per (name, home, shell) for the process lifetime —
 * shell startup files do not change mid-session in any practical scenario,
 * and PTY spawn is on the hot path.
 */
export function readShellStartupEnvVar(
  name: string,
  home = process.env.HOME,
  shell = process.env.SHELL
): string | undefined {
  if (!home || process.platform === 'win32') {
    return undefined
  }
  // Why: the regex above is fixed; rejecting unsafe names is cheap defense
  // for the day a future caller passes something with regex metacharacters.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return undefined
  }

  const cacheKey = `${name}\0${home}\0${shell ?? ''}`
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)
  }

  const assignment = new RegExp(`^export\\s+${name}=(.+)$`)
  let lastMatch: string | undefined

  for (const file of shellStartupFiles(shell)) {
    const path = join(home, file)
    if (!existsSync(path)) {
      continue
    }

    let content
    try {
      content = readFileSync(path, 'utf8')
    } catch {
      continue
    }

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim()
      const match = assignment.exec(line)
      if (!match?.[1]) {
        continue
      }
      // Why: strip trailing unquoted `# comment` first so quoted values like
      // `"$HOME/.opencode" # note` survive intact for unquoteShellValue.
      const decommented = stripTrailingComment(match[1])
      const { text, quoted } = unquoteShellValue(decommented)
      // Why: $HOME / ${HOME} / ~ expansion mimics what the live shell would
      // do for double-quoted and unquoted values; single-quoted is literal.
      const expanded = quoted === "'" ? text : expandHome(text, home)
      if (expanded.length > 0) {
        lastMatch = expanded
      }
    }
  }

  cache.set(cacheKey, lastMatch)
  return lastMatch
}

/**
 * Test-only helper to reset the per-process cache between cases.
 * Why: production callers never invalidate (rc files don't change at
 * runtime), but tests need clean state per case.
 */
export function __resetShellStartupEnvCache(): void {
  cache.clear()
}
