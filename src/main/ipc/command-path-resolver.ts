import { access, constants as fsConstants, stat } from 'node:fs/promises'
import path from 'node:path'

export type ResolveCommandOptions = {
  /** Defaults to `process.platform`. Lets tests exercise the win32 lookup on posix. */
  platform?: NodeJS.Platform
  /** Env whose PATH/PATHEXT to search. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** CWD used only for the win32 "search current directory first" rule. */
  cwd?: string
}

// Why: Windows env keys are case-insensitive (PATH is usually stored as `Path`,
// PATHEXT as `PathExt`), but the merged env object we search is a plain,
// case-sensitive Record — so look the key up case-insensitively.
function readEnvCaseInsensitive(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key]
  if (direct !== undefined) {
    return direct
  }
  const lowerKey = key.toLowerCase()
  for (const [envKey, value] of Object.entries(env)) {
    if (envKey.toLowerCase() === lowerKey) {
      return value
    }
  }
  return undefined
}

function getWindowsExtensions(env: NodeJS.ProcessEnv, command: string): string[] {
  const pathext = readEnvCaseInsensitive(env, 'PATHEXT') ?? '.EXE;.CMD;.BAT;.COM'
  const extensions = pathext.split(';').filter((ext) => ext.length > 0)
  // Why: when the command already carries an extension (e.g. `node.exe`), an
  // exact-name match must be allowed alongside the PATHEXT permutations.
  if (command.includes('.')) {
    extensions.unshift('')
  }
  return extensions
}

async function isExecutableFile(candidate: string, isWin: boolean): Promise<boolean> {
  try {
    // Why: stat (not lstat) so symlinked CLIs resolve to their real target.
    const stats = await stat(candidate)
    if (stats.isDirectory()) {
      // Why: PATH dirs carry the search/exec bit; reject them like `[ ! -d ]`.
      return false
    }
    if (isWin) {
      // Extension membership already enforced by the PATHEXT permutation.
      return stats.isFile()
    }
    await access(candidate, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve whether `command` is an executable on PATH using only `node:fs`
 * — zero `where`/`which` subprocess spawns. Mirrors the canonical
 * which(1)/where.exe lookup, including the current preflight quirk that only
 * counts matches which resolve to an ABSOLUTE path (so relative PATH entries
 * and relative command paths stay not-found, exactly as before).
 */
export async function isCommandOnLocalPath(
  command: string,
  options: ResolveCommandOptions = {}
): Promise<boolean> {
  if (!command) {
    return false
  }
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const isWin = platform === 'win32'
  // Why: apply platform-correct absolute-path semantics (e.g. `C:\..` is
  // absolute on win32 but not posix) for the same-as-before isAbsolute gate.
  const isAbsolute = isWin ? path.win32.isAbsolute : path.posix.isAbsolute
  const delimiter = isWin ? ';' : ':'

  const hasPathSeparator = command.includes('/') || (isWin && command.includes('\\'))
  const pathDirs = (readEnvCaseInsensitive(env, 'PATH') ?? '').split(delimiter)
  // Why: a slash short-circuits PATH (resolve the command directly), matching
  // which(1). On win32, where.exe searches the current directory first.
  const searchDirs = hasPathSeparator ? [''] : isWin ? [cwd, ...pathDirs] : pathDirs
  const extensions = isWin ? getWindowsExtensions(env, command) : ['']

  for (const dir of searchDirs) {
    for (const ext of extensions) {
      // Why: forward-slash joins so candidates are statable on every platform
      // (Windows fs accepts `/`), keeping the win32 lookup testable off-Windows.
      const candidate = path.posix.join(dir, command) + ext
      // Why: preserve the prior `.some(line => path.isAbsolute(line))` filter
      // over where/which stdout — only absolute resolutions count.
      if (!isAbsolute(candidate)) {
        continue
      }
      if (await isExecutableFile(candidate, isWin)) {
        return true
      }
    }
  }
  return false
}
