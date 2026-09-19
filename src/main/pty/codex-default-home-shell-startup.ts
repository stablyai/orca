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
export function scrubCodexDefaultHomeMarkerForLaunch(
  env: Record<string, string>,
  supportsCodexDefaultHomeAfterProfile: boolean | undefined
): void {
  if (!supportsCodexDefaultHomeAfterProfile) {
    delete env[ORCA_CODEX_DEFAULT_HOME_AFTER_PROFILE_ENV]
  }
}
