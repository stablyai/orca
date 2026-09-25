import { existsSync } from 'node:fs'
import { win32 as pathWin32 } from 'node:path'
import { WINDOWS_CMDER_SHELL } from '../shared/windows-terminal-shell'

export const ORCA_CMDER_INIT_ENV = 'ORCA_CMDER_INIT'
export const ORCA_CMDER_INIT_QUOTE_ENV = 'ORCA_CMDER_INIT_QUOTE'
export const ORCA_CMDER_ROOT_ENV = 'ORCA_CMDER_ROOT'

let configuredCmderRoot: string | null = null

/** Carries the Cmder setting into the spawn env so the out-of-process daemon resolves the same root. */
export function applyConfiguredCmderRootEnv(
  spawnOptions: { env?: Record<string, string> },
  configuredRoot: string | undefined
): void {
  const root = configuredRoot?.trim()
  // Why drop first: a carried key from an earlier setting would outrank CMDER_ROOT after the setting is cleared.
  const { [ORCA_CMDER_ROOT_ENV]: _stale, ...env } = spawnOptions.env ?? {}
  if (root) {
    spawnOptions.env = { ...env, [ORCA_CMDER_ROOT_ENV]: root }
  } else if (spawnOptions.env) {
    spawnOptions.env = env
  }
}

/** Settings-provided Cmder folder; it outranks CMDER_ROOT and guessed install dirs. */
export function setConfiguredCmderRoot(root: string | null | undefined): void {
  configuredCmderRoot = root?.trim() || null
}

type CmderRootOptions = {
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
  platform?: NodeJS.Platform
}

function readEnv(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim()
    if (value) {
      return value
    }
  }
  return undefined
}

function stripQuotes(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
}

export function getCmderInitScriptPath(root: string): string {
  return pathWin32.join(root, 'vendor', 'init.bat')
}

export function getCmderRootCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()
  const push = (candidate: string | undefined): void => {
    if (!candidate) {
      return
    }
    const normalized = pathWin32.normalize(stripQuotes(candidate)).replace(/\\+$/, '')
    const key = normalized.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      candidates.push(normalized)
    }
  }

  // Why: spawn paths inject the setting as ORCA_CMDER_ROOT so the separate daemon process sees it too.
  push(readEnv(env, [ORCA_CMDER_ROOT_ENV]) ?? configuredCmderRoot ?? undefined)
  // Why: Cmder's installer and docs both publish CMDER_ROOT; it wins over guessed locations.
  push(readEnv(env, ['CMDER_ROOT', 'cmder_root']))
  const userProfile = readEnv(env, ['USERPROFILE', 'UserProfile'])
  const systemDrive = readEnv(env, ['SystemDrive', 'SYSTEMDRIVE']) ?? 'C:'
  const programRoots = [
    readEnv(env, ['ProgramFiles', 'PROGRAMFILES']),
    readEnv(env, ['ProgramFiles(x86)', 'PROGRAMFILES(X86)']),
    readEnv(env, ['LOCALAPPDATA', 'LocalAppData'])
  ]
  for (const root of programRoots) {
    if (root) {
      push(pathWin32.join(root, 'cmder'))
    }
  }
  if (userProfile) {
    push(pathWin32.join(userProfile, 'cmder'))
    push(pathWin32.join(userProfile, 'scoop', 'apps', 'cmder', 'current'))
    push(pathWin32.join(userProfile, 'scoop', 'apps', 'cmder-full', 'current'))
  }
  push(pathWin32.join(`${systemDrive}\\`, 'tools', 'cmder'))
  push(pathWin32.join(`${systemDrive}\\`, 'cmder'))
  return candidates
}

export function resolveCmderRoot(options: CmderRootOptions = {}): string | null {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    return null
  }
  const exists = options.exists ?? existsSync
  for (const candidate of getCmderRootCandidates(options.env ?? process.env)) {
    if (exists(getCmderInitScriptPath(candidate))) {
      return candidate
    }
  }
  return null
}

export function isCmderAvailable(): boolean {
  return resolveCmderRoot() !== null
}

/** Orca launched from a Cmder console inherits CMDER_CONFIGURED, which makes init.bat skip setup. */
export function stripInheritedCmderState(env: Record<string, string>): void {
  delete env[ORCA_CMDER_ROOT_ENV]
  delete env.CMDER_CONFIGURED
  delete env.CMDER_INIT_START
  delete env.CMDER_INIT_END
}

/** Env Cmder's init.bat expects, plus the path/quote pair the cmd `/K` chain expands. */
export function applyCmderSpawnEnvironment(env: Record<string, string>, cmderRoot: string): void {
  stripInheritedCmderState(env)
  env.CMDER_ROOT = cmderRoot
  env[ORCA_CMDER_INIT_ENV] = getCmderInitScriptPath(cmderRoot)
  env[ORCA_CMDER_INIT_QUOTE_ENV] = '"'
}

/** Cmder root for a requested shell, or null when the request is not Cmder (or Cmder is missing). */
export function resolveWindowsCmderShellRoot(
  shell: string | undefined,
  options: CmderRootOptions = {}
): string | null {
  return shell?.trim().toLowerCase() === WINDOWS_CMDER_SHELL ? resolveCmderRoot(options) : null
}
