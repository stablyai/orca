import { join } from 'node:path'
import { CLAUDE_PROFILE_POINTER_ENV } from '../../shared/claude-profile-routing'
import { isDirectory } from './claude-profile-homes'
// Keep the router setup graph out of scan workers.
import type { ClaudeProfileRouter } from './claude-profile-router'
import type { ClaudeWslProfileRouter } from './claude-profile-wsl-router'
import type { ClaudeAccountSelectionTarget } from './runtime-selection'
import type { ClaudeObservedConfigDirs } from './claude-observed-config-dirs'

let installed: ClaudeProfileRouter | undefined

/** Installed only in the desktop process. */
export function installClaudeProfileRouter(router: ClaudeProfileRouter | undefined): void {
  installed = router
}

export function getClaudeProfileRouter(): ClaudeProfileRouter | undefined {
  return installed
}

let installedObserved: ClaudeObservedConfigDirs | undefined

export function installClaudeObservedConfigDirs(dirs: ClaudeObservedConfigDirs | undefined): void {
  installedObserved = dirs
}

export function getClaudeObservedConfigDirs(): ClaudeObservedConfigDirs | undefined {
  return installedObserved
}

let installedWsl: ClaudeWslProfileRouter | undefined

export function installClaudeWslProfileRouter(router: ClaudeWslProfileRouter | undefined): void {
  installedWsl = router
}

export function getClaudeWslProfileRouter(): ClaudeWslProfileRouter | undefined {
  return installedWsl
}

let installedWslProjectPointer:
  | ((target: ClaudeAccountSelectionTarget) => Promise<string | null>)
  | undefined

export function installClaudeWslProjectPointer(
  publish: ((target: ClaudeAccountSelectionTarget) => Promise<string | null>) | undefined
): void {
  installedWslProjectPointer = publish
}

/** A pinned project's WSL pane gets its own pointer, written before the shell can run `claude`;
 *  any failure keeps the selection's pointer rather than block the terminal. */
export async function withClaudeProjectWslPointer<Env extends Record<string, string> | undefined>(
  env: Env,
  target: ClaudeAccountSelectionTarget
): Promise<Env | Record<string, string>> {
  if (target.runtime !== 'wsl' || !target.worktreeId || !installedWslProjectPointer) {
    return env
  }
  const pointer = await installedWslProjectPointer(target).catch((error: unknown) => {
    console.warn('[claude-profile] Could not pin the WSL project account:', error)
    return null
  })
  return pointer ? { ...env, [CLAUDE_PROFILE_POINTER_ENV]: pointer } : env
}

export function withClaudeProfileTerminalEnv<Env extends Record<string, string> | undefined>(
  env: Env,
  target: ClaudeAccountSelectionTarget
): Env | Record<string, string> {
  const profileEnv = installed?.terminalEnv(target, target.worktreeId)
  return profileEnv ? { ...env, ...profileEnv } : env
}

/** The user's CLAUDE_CONFIG_DIR from the login shell, folders Orca saw Claude use, and account homes. */
export function claudeProfileHistoryDirs(surface: 'projects' | 'transcripts'): string[] {
  const homes = [
    installed?.userConfigDir(),
    ...(installedObserved?.list() ?? []),
    ...(installed?.accountHomes() ?? [])
  ].filter((home): home is string => Boolean(home))
  const dirs = homes.map((home) => join(home, surface)).filter(isDirectory)
  return dirs.filter((dir, index) => dirs.indexOf(dir) === index)
}
