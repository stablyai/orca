import { win32 as pathWin32 } from 'node:path'
import { isWindowsGitBashShellPath } from '../git-bash'

export const ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE_ENV = 'ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE'
export const ORCA_CODEX_DEFAULT_HOME_UNSET_AFTER_PROFILE = '1'

/** Keeps only an explicit, internally coherent reset request after daemon inheritance is merged. */
export function reconcileDaemonCodexDefaultHomeMarker(
  env: Record<string, string>,
  requestedEnv: Record<string, string> | undefined
): void {
  const requestedValue = requestedEnv?.[ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE_ENV]
  if (!requestedValue) {
    delete env[ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE_ENV]
    return
  }
  const effectiveCodexHome = env.CODEX_HOME?.trim()
  if (
    (requestedValue === ORCA_CODEX_DEFAULT_HOME_UNSET_AFTER_PROFILE && effectiveCodexHome) ||
    (requestedValue !== ORCA_CODEX_DEFAULT_HOME_UNSET_AFTER_PROFILE &&
      effectiveCodexHome !== requestedValue)
  ) {
    // Why: main cannot override user-owned environment inherited only by a persistent daemon.
    delete env[ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE_ENV]
  }
}

/** Drops the one-shot marker from shells whose startup path cannot consume it. */
export function scrubCodexDefaultHomeMarkerForWindowsShell(
  env: Record<string, string>,
  shellPath: string
): void {
  const shellName = pathWin32.basename(shellPath).toLowerCase()
  if (
    shellName !== 'powershell.exe' &&
    shellName !== 'pwsh.exe' &&
    !isWindowsGitBashShellPath(shellPath)
  ) {
    delete env[ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE_ENV]
  }
}
