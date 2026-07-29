import { existsSync, readlinkSync, statSync } from 'node:fs'
import { win32 as pathWin32 } from 'node:path'

/** Dependency seams so the resolver can be unit-tested without a real Windows
 *  filesystem. Production callers omit these and get process.env / fs. */
export type WindowsPowerShellResolveOptions = {
  env?: NodeJS.ProcessEnv
  /** Returns true when the candidate path is a real, non-empty executable. */
  isRealExecutable?: (path: string) => boolean
  /** Resolves a Store App Execution Alias to its package executable. */
  resolveAppExecutionAlias?: (path: string) => string | null
  platform?: NodeJS.Platform
}

/** Why: the Microsoft Store ships `pwsh.exe`/`powershell.exe` App Execution
 *  Alias stubs under WindowsApps. They are zero-byte reparse points that
 *  execFileSync can launch (PATH lookup follows the alias) but ConPTY's
 *  CreateProcessW(lpApplicationName=<abs stub>) rejects with ERROR_ACCESS_DENIED
 *  (error code 5). Never resolve a shell to a path inside this directory. */
function isWindowsAppExecutionAliasPath(candidate: string): boolean {
  return /[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(pathWin32.normalize(candidate))
}

/** A real executable is a regular file with non-zero size. The App Execution
 *  Alias stubs report size 0, so the size check rejects them even if a future
 *  Windows build relocates them outside WindowsApps. */
function defaultIsRealExecutable(candidate: string): boolean {
  if (isWindowsAppExecutionAliasPath(candidate)) {
    return false
  }
  try {
    if (!existsSync(candidate)) {
      return false
    }
    const stat = statSync(candidate)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

function defaultResolveAppExecutionAlias(candidate: string): string | null {
  try {
    const target = readlinkSync(candidate)
    return pathWin32.resolve(pathWin32.dirname(candidate), target)
  } catch {
    return null
  }
}

function readEnv(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]
    if (value) {
      return value
    }
  }
  return undefined
}

function getPathExecutableCandidates(env: NodeJS.ProcessEnv, executable: string): string[] {
  const pathValue = readEnv(env, ['PATH', 'Path', 'path'])
  if (!pathValue) {
    return []
  }

  const candidates: string[] = []
  const seen = new Set<string>()
  for (const rawPart of pathValue.split(pathWin32.delimiter)) {
    const dir = rawPart.trim().replace(/^"|"$/g, '')
    // Why: Windows' implicit current-directory search can pick up repo-local
    // shims. Only absolute PATH entries become ConPTY launch candidates.
    if (!pathWin32.isAbsolute(dir)) {
      continue
    }
    pushUniqueCandidate(candidates, seen, pathWin32.join(dir, executable))
  }
  return candidates
}

function pushUniqueCandidate(
  candidates: string[],
  seen: Set<string>,
  candidate: string | undefined
): void {
  if (!candidate) {
    return
  }
  const normalized = pathWin32.normalize(candidate)
  const key = normalized.toLowerCase()
  if (!seen.has(key)) {
    seen.add(key)
    candidates.push(normalized)
  }
}

/** Known absolute install locations for PowerShell 7 (`pwsh.exe`), ordered by
 *  preference: per-machine MSI installs first, then per-user. */
function getPwshCandidatePaths(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()
  const programFilesRoots = [
    readEnv(env, ['ProgramW6432', 'PROGRAMW6432']),
    readEnv(env, ['ProgramFiles', 'PROGRAMFILES']),
    readEnv(env, ['ProgramFiles(x86)', 'PROGRAMFILES(X86)'])
  ]
  for (const root of programFilesRoots) {
    if (!root) {
      continue
    }
    // PowerShell 7 MSI installs land in `PowerShell\7\pwsh.exe`. Glob the major
    // version conservatively (6/7/8) so future majors keep resolving.
    for (const major of ['7', '8', '6']) {
      pushUniqueCandidate(candidates, seen, pathWin32.join(root, 'PowerShell', major, 'pwsh.exe'))
    }
  }
  // Per-user dotnet-tool / winget install location.
  const localAppData = readEnv(env, ['LOCALAPPDATA', 'LocalAppData'])
  if (localAppData) {
    for (const major of ['7', '8', '6']) {
      pushUniqueCandidate(
        candidates,
        seen,
        pathWin32.join(localAppData, 'Microsoft', 'PowerShell', major, 'pwsh.exe')
      )
    }
  }
  for (const candidate of getPathExecutableCandidates(env, 'pwsh.exe')) {
    pushUniqueCandidate(candidates, seen, candidate)
  }
  return candidates
}

/** Absolute path to inbox Windows PowerShell (`powershell.exe`), which always
 *  ships at System32\WindowsPowerShell\v1.0 on a stock Windows install. */
function getWindowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  const systemRoot = readEnv(env, ['SystemRoot', 'WINDIR', 'windir']) || 'C:\\Windows'
  return pathWin32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** Absolute path to cmd.exe, the last-resort fallback shell. */
export function getWindowsCmdPath(env: NodeJS.ProcessEnv = process.env): string {
  const comspec = readEnv(env, ['ComSpec', 'COMSPEC'])
  if (comspec) {
    return comspec
  }
  const systemRoot = readEnv(env, ['SystemRoot', 'WINDIR', 'windir']) || 'C:\\Windows'
  return pathWin32.join(systemRoot, 'System32', 'cmd.exe')
}

/**
 * Resolve a PowerShell family name to a real absolute executable path.
 *
 * Returns null when no real executable or safely resolvable Store alias target
 * can be found for the family. Callers then try the next Windows shell fallback.
 */
export function resolveWindowsPowerShellExecutablePath(
  family: 'pwsh.exe' | 'powershell.exe',
  options: WindowsPowerShellResolveOptions = {}
): string | null {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    return null
  }
  const env = options.env ?? process.env
  const isRealExecutable = options.isRealExecutable ?? defaultIsRealExecutable
  const resolveAppExecutionAlias =
    options.resolveAppExecutionAlias ?? defaultResolveAppExecutionAlias

  if (family === 'powershell.exe') {
    const windowsPowerShell = getWindowsPowerShellPath(env)
    return isRealExecutable(windowsPowerShell) ? windowsPowerShell : null
  }

  for (const candidate of getPwshCandidatePaths(env)) {
    if (isWindowsAppExecutionAliasPath(candidate)) {
      const target = resolveAppExecutionAlias(candidate)
      // Why: ConPTY cannot launch the alias reparse point, but its real Store
      // package target is a normal executable that preserves the user's pwsh choice.
      if (
        target &&
        pathWin32.isAbsolute(target) &&
        pathWin32.basename(target).toLowerCase() === 'pwsh.exe' &&
        !isWindowsAppExecutionAliasPath(target) &&
        isRealExecutable(target)
      ) {
        return pathWin32.normalize(target)
      }
      continue
    }
    if (isRealExecutable(candidate)) {
      return candidate
    }
  }
  return null
}

/**
 * Build the ordered Windows shell-spawn fallback chain for a requested
 * PowerShell family. Each entry is a real absolute path that ConPTY can launch.
 *
 * Order: requested PowerShell (resolved abs) -> inbox Windows PowerShell (abs)
 * -> cmd.exe. Duplicates and unresolved links are dropped. The chain is never
 * empty because cmd.exe always closes it.
 */
export function resolveWindowsPowerShellSpawnChain(
  requestedFamily: 'pwsh.exe' | 'powershell.exe',
  options: WindowsPowerShellResolveOptions = {}
): string[] {
  const env = options.env ?? process.env
  const chain: string[] = []
  const seen = new Set<string>()
  const add = (candidate: string | null): void => {
    if (candidate) {
      pushUniqueCandidate(chain, seen, candidate)
    }
  }

  add(resolveWindowsPowerShellExecutablePath(requestedFamily, options))
  // Always offer inbox Windows PowerShell as the next link: it is present on
  // every supported Windows and is not subject to the Store alias hazard.
  add(resolveWindowsPowerShellExecutablePath('powershell.exe', options))
  // cmd.exe is the guaranteed last resort so a terminal still opens even when
  // both PowerShell flavors are blocked by AV/AppLocker/SAC.
  pushUniqueCandidate(chain, seen, getWindowsCmdPath(env))
  return chain
}
