import { existsSync, readlinkSync, statSync } from 'node:fs'
import { win32 as pathWin32 } from 'node:path'

export type WindowsPowerShellResolveOptions = {
  env?: NodeJS.ProcessEnv
  /** Returns true when the candidate path is a real, non-empty executable. */
  isRealExecutable?: (path: string) => boolean
  /** Resolves a Store App Execution Alias to its package executable. */
  resolveAppExecutionAlias?: (path: string) => string | null
  platform?: NodeJS.Platform
}

/** Store alias reparse stubs may launch through execFile PATH lookup but fail ConPTY absolute CreateProcessW (5). */
function isWindowsAppExecutionAliasPath(candidate: string): boolean {
  return /[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(pathWin32.normalize(candidate))
}

/** Reject zero-byte alias stubs even if future Windows versions move them outside WindowsApps. */
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
    // Relative PATH entries enable repo-local shell hijacking; accept only absolute directories.
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
    // Prefer major 7 while probing adjacent 8/6 install directories for compatibility.
    for (const major of ['7', '8', '6']) {
      pushUniqueCandidate(candidates, seen, pathWin32.join(root, 'PowerShell', major, 'pwsh.exe'))
    }
  }
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

function getWindowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  const systemRoot = readEnv(env, ['SystemRoot', 'WINDIR', 'windir']) || 'C:\\Windows'
  return pathWin32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

export function getWindowsCmdPath(env: NodeJS.ProcessEnv = process.env): string {
  const comspec = readEnv(env, ['ComSpec', 'COMSPEC'])
  if (comspec) {
    return comspec
  }
  const systemRoot = readEnv(env, ['SystemRoot', 'WINDIR', 'windir']) || 'C:\\Windows'
  return pathWin32.join(systemRoot, 'System32', 'cmd.exe')
}

/** Null when neither a real executable nor safe Store package target resolves; callers try the next shell. */
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
      // ConPTY cannot launch the alias itself; its real package target preserves the requested pwsh.
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

/** Deduplicated requested PowerShell → inbox PowerShell → cmd.exe fallback paths. */
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
  // Inbox PowerShell avoids Store alias launch hazards.
  add(resolveWindowsPowerShellExecutablePath('powershell.exe', options))
  // cmd.exe remains the last attempt when policy blocks both PowerShell variants.
  pushUniqueCandidate(chain, seen, getWindowsCmdPath(env))
  return chain
}
