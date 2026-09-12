import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'

// Why: only files the user's actual shell would source. Mixing zsh and bash
// files breaks the "last assignment wins matches the live shell" guarantee —
// a stale .bash_profile on a zsh user would clobber the real .zshrc value.
const ZSH_ENV_FILE = '.zshenv'
const ZSH_AFTER_ENV_FILES = ['.zprofile', '.zshrc', '.zlogin']
// Why: Orca launches bash as a login shell (see local-pty-shell-ready.ts
// getBashShellReadyRcfileContent and daemon/shell-ready.ts) which sources
// .bash_profile / .bash_login / .profile but intentionally does NOT force
// .bashrc. Scanning .bashrc would mirror values the live Orca bash never sees.
const BASH_LOGIN_FILES = ['.bash_profile', '.bash_login', '.profile']
// Why: fish sources conf.d/*.fish (sorted by name) before config.fish, for
// login and non-login shells alike — verified against fish 4.7.
const FISH_SNIPPET_DIR = 'conf.d'
const FISH_SNIPPET_SUFFIX = '.fish'
const FISH_CONFIG_FILE = 'config.fish'

/** Assignment grammar of a startup file: `export NAME=value` vs fish `set -gx NAME value`. */
type StartupFileSyntax = 'export' | 'fish-set'

type ShellStartupFiles = {
  paths: readonly string[]
  syntax: StartupFileSyntax
}

export function isShellStartupEnvProbeSupported(): boolean {
  return process.platform !== 'win32'
}

function parseAssignedValue(
  content: string,
  name: string,
  home: string,
  syntax: StartupFileSyntax
): string | undefined {
  const assignment =
    syntax === 'fish-set'
      ? new RegExp(`^set\\s+((?:-{1,2}[A-Za-z][\\w-]*\\s+)+)${name}\\s+(.+)$`)
      : new RegExp(`^export\\s+${name}=()(.+)$`)
  let lastMatch: string | undefined

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    const match = assignment.exec(line)
    if (!match?.[2] || (syntax === 'fish-set' && !fishFlagsExport(match[1] ?? ''))) {
      continue
    }
    // Why: strip trailing unquoted `# comment` first so quoted values like
    // `"$HOME/.opencode" # note` survive intact for unquoteShellValue.
    const decommented = stripTrailingComment(match[2])
    const { text, quoted } = unquoteShellValue(decommented)
    // Why: $HOME / ${HOME} / ~ expansion mimics what the live shell would
    // do for double-quoted and unquoted values; single-quoted is literal.
    const expanded = quoted === "'" ? text : expandHome(text, home)
    if (expanded.length > 0) {
      lastMatch = expanded
    }
  }

  return lastMatch
}

function parseExportedValue(content: string, name: string, home: string): string | undefined {
  return parseAssignedValue(content, name, home, 'export')
}

// Why: only `set -x` / `--export` reaches child processes; `set -g`, `set -l`
// and function-local sets never appear in the PTY's environment.
function fishFlagsExport(flags: string): boolean {
  return flags
    .trim()
    .split(/\s+/)
    .some((flag) =>
      flag.startsWith('--') ? flag === '--export' : /^-[A-Za-z]*x[A-Za-z]*$/.test(flag)
    )
}

function readStartupFile(path: string): string | null {
  if (!existsSync(path)) {
    return null
  }
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function shellStartupFiles(
  home: string,
  shell: string | undefined,
  configHome: string | undefined
): ShellStartupFiles {
  if (!shell) {
    // Why: Orca's POSIX default shell is /bin/zsh when $SHELL is unset.
    return { paths: zshStartupFilePaths(home), syntax: 'export' }
  }

  const name = posix.basename(shell).toLowerCase()
  if (name === 'zsh') {
    return { paths: zshStartupFilePaths(home), syntax: 'export' }
  }
  if (name === 'bash') {
    return {
      paths: BASH_LOGIN_FILES.map((file) => posix.join(home, file)),
      syntax: 'export'
    }
  }
  if (name === 'fish') {
    return {
      paths: fishStartupFilePaths(home, configHome),
      syntax: 'fish-set'
    }
  }
  // Why: unsupported explicit shells (nushell, custom wrappers) do not use
  // Orca's zsh/bash/fish shell-ready startup files, so scanning those files
  // would mirror values the live PTY shell never sees.
  return { paths: [], syntax: 'export' }
}

function fishStartupFilePaths(home: string, configHome: string | undefined): readonly string[] {
  const fishDir = posix.join(configHome?.trim() || posix.join(home, '.config'), 'fish')
  return [
    ...fishSnippetPaths(posix.join(fishDir, FISH_SNIPPET_DIR)),
    posix.join(fishDir, FISH_CONFIG_FILE)
  ]
}

function fishSnippetPaths(snippetDir: string): readonly string[] {
  try {
    return readdirSync(snippetDir)
      .filter((entry) => entry.endsWith(FISH_SNIPPET_SUFFIX))
      .sort()
      .map((entry) => posix.join(snippetDir, entry))
  } catch {
    return []
  }
}

function zshStartupFilePaths(home: string): readonly string[] {
  const zshEnvPath = posix.join(home, ZSH_ENV_FILE)
  const zshEnv = readStartupFile(zshEnvPath)
  // Why: zsh sources ~/.zshenv first, then uses any ZDOTDIR exported there
  // for .zprofile/.zshrc/.zlogin. Mirror that enough for static env discovery
  // so users who keep zsh config in ~/.config/zsh do not lose overlay sources.
  const zshDir = zshEnv ? (parseExportedValue(zshEnv, 'ZDOTDIR', home) ?? home) : home
  return [zshEnvPath, ...ZSH_AFTER_ENV_FILES.map((file) => posix.join(zshDir, file))]
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
 * - Bare assignments (no `export` keyword, or fish `set` without `-x`) are
 *   ignored because they never reach child processes.
 * - Files are scanned in shell evaluation order for the user's $SHELL family
 *   only (zsh OR bash OR fish, never mixed); unsupported explicit shells scan
 *   nothing. LAST matching assignment wins.
 * - fish universal variables (`set -Ux` stored in fish_variables) are only
 *   seen when the assignment is also written in a config file.
 * - Windows is unsupported (PowerShell profile parsing is out of scope).
 *
 * Results are memoized per (name, home, shell, configHome) for the process
 * lifetime — shell startup files do not change mid-session in any practical
 * scenario, and PTY spawn is on the hot path.
 */
export function readShellStartupEnvVar(
  name: string,
  home = process.env.HOME,
  shell = process.env.SHELL,
  configHome = process.env.XDG_CONFIG_HOME
): string | undefined {
  if (!home || !isShellStartupEnvProbeSupported()) {
    return undefined
  }
  // Why: the regex above is fixed; rejecting unsafe names is cheap defense
  // for the day a future caller passes something with regex metacharacters.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return undefined
  }

  const cacheKey = `${name}\0${home}\0${shell ?? ''}\0${configHome ?? ''}`
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)
  }

  let lastMatch: string | undefined

  const { paths, syntax } = shellStartupFiles(home, shell, configHome)
  for (const path of paths) {
    const content = readStartupFile(path)
    if (content === null) {
      continue
    }

    const match = parseAssignedValue(content, name, home, syntax)
    if (match !== undefined) {
      lastMatch = match
    }
  }

  cache.set(cacheKey, lastMatch)
  return lastMatch
}

/** The env keys that decide which startup files a shell would actually source. */
export type ShellStartupEnvSource = {
  HOME?: string | undefined
  SHELL?: string | undefined
  XDG_CONFIG_HOME?: string | undefined
}

/**
 * Same probe, resolved against a session/PTY env with process.env as fallback.
 *
 * Why this exists rather than three inline `??` chains per call site: dropping
 * XDG_CONFIG_HOME silently scans a *different* fish config than the shell will,
 * so local launches and relay launches disagree about the same user's
 * `set -gx` — a divergence with no visible symptom until it is wrong.
 */
export function readSessionShellStartupEnvVar(
  name: string,
  sessionEnv: ShellStartupEnvSource | undefined,
  shellOverride?: string
): string | undefined {
  return readShellStartupEnvVar(
    name,
    sessionEnv?.HOME ?? process.env.HOME,
    shellOverride ?? sessionEnv?.SHELL ?? process.env.SHELL,
    sessionEnv?.XDG_CONFIG_HOME ?? process.env.XDG_CONFIG_HOME
  )
}

/**
 * Test-only helper to reset the per-process cache between cases.
 * Why: production callers never invalidate (rc files don't change at
 * runtime), but tests need clean state per case.
 */
export function __resetShellStartupEnvCache(): void {
  cache.clear()
}
