import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'

// Scan only the active shell family; mixing files lets unused config override the real startup value.
const ZSH_ENV_FILE = '.zshenv'
const ZSH_AFTER_ENV_FILES = ['.zprofile', '.zshrc', '.zlogin']
// Orca login Bash sources the first available login file and does not force .bashrc.
const BASH_LOGIN_FILES = ['.bash_profile', '.bash_login', '.profile']
// fish reads sorted conf.d snippets before config.fish for login and non-login shells.
const FISH_SNIPPET_DIR = 'conf.d'
const FISH_SNIPPET_SUFFIX = '.fish'
const FISH_CONFIG_FILE = 'config.fish'

type StartupFileSyntax = 'export' | 'fish-set'

type ShellStartupFiles = {
  paths: readonly string[]
  syntax: StartupFileSyntax
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
    // Strip only unquoted trailing comments before unquoting the value.
    const decommented = stripTrailingComment(match[2])
    const { text, quoted } = unquoteShellValue(decommented)
    // Single quotes preserve HOME/tilde literally.
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

// Only exported fish assignments reach child processes.
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
    // Match Orca's /bin/zsh fallback when SHELL is unset.
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
  // Unsupported explicit shells do not read Orca's Bash/zsh/fish startup files.
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
  // .zshenv can redirect later startup files through ZDOTDIR.
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

export function stripTrailingComment(value: string): string {
  // Preserve quoted hashes and hashes within words; only unquoted word-boundary # starts a comment.
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
  // Expand HOME only at its boundary, never inside HOMER/HOMEPATH/HOME_DIR.
  return value
    .replace(/^~(?=$|\/)/, home)
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME(?![A-Za-z0-9_])/g, home)
}

export const SHELL_STARTUP_ENV_CACHE_MAX_ENTRIES = 256
const cache = new Map<string, string | undefined>()

/** Discover exported overlay sources before GUI-launched Orca's PTY rc files overwrite the overlay.
 * Static hint only: active-shell startup order, last assignment wins; no conditionals, sourcing or expansion beyond HOME/tilde.
 * fish universal values require a config assignment; Windows defaults read nothing (Git Bash/PowerShell use separate probes).
 * Bounded memoization keys by name, home, shell and configHome. */
export function readShellStartupEnvVar(
  name: string,
  home = process.env.HOME,
  shell = process.env.SHELL,
  configHome = process.env.XDG_CONFIG_HOME
): string | undefined {
  return process.platform === 'win32'
    ? undefined
    : readStartupFilesEnvVar(name, home, shell, configHome)
}

/** The same probe over bash login files, for a Windows pane running Git Bash. */
export function readBashStartupEnvVar(name: string, home: string): string | undefined {
  return readStartupFilesEnvVar(name, home, 'bash', undefined)
}

function readStartupFilesEnvVar(
  name: string,
  home: string | undefined,
  shell: string | undefined,
  configHome: string | undefined
): string | undefined {
  if (!home) {
    return undefined
  }
  // Validate names before interpolating into assignment regexes.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return undefined
  }

  const cacheKey = `${name}\0${home}\0${shell ?? ''}\0${configHome ?? ''}`
  const cached = cache.get(cacheKey)
  if (cache.has(cacheKey)) {
    // Keep frequently used homes warm when historical homes churn.
    cache.delete(cacheKey)
    cache.set(cacheKey, cached)
    return cached
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
  while (cache.size > SHELL_STARTUP_ENV_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next()
    if (oldest.done) {
      break
    }
    cache.delete(oldest.value)
  }
  return lastMatch
}

export type ShellStartupEnvSource = {
  HOME?: string | undefined
  SHELL?: string | undefined
  XDG_CONFIG_HOME?: string | undefined
}

/** Include session XDG_CONFIG_HOME with HOME/SHELL so local and relay probes inspect the same fish config. */
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

export function __resetShellStartupEnvCache(): void {
  cache.clear()
}
