import { win32 as pathWin32 } from 'node:path'
import { isWindowsGitBashShellPath } from '../git-bash'

export const ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE_ENV = 'ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE'
export const ORCA_CODEX_DEFAULT_HOME_UNSET_AFTER_PROFILE = '1'

/** Applies main's prepared default-home selection to one daemon child environment. */
export function reconcileDaemonCodexDefaultHomeMarker(
  env: Record<string, string>,
  requestedEnv: Record<string, string> | undefined
): void {
  const requestedValue = requestedEnv?.[ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE_ENV]
  if (!requestedValue) {
    delete env[ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE_ENV]
    return
  }
  if (requestedValue === ORCA_CODEX_DEFAULT_HOME_UNSET_AFTER_PROFILE) {
    delete env.CODEX_HOME
  } else {
    env.CODEX_HOME = requestedValue
  }
  delete env.ORCA_CODEX_HOME
  env[ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE_ENV] = requestedValue
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
