/**
 * Routing truth for the SYSTEM-DEFAULT Codex account: it always runs against
 * the user's real ~/.codex; managed (multi-account) selections always get
 * their own self-contained homes. There is no user-facing setting — the
 * feature ships unconditionally.
 *
 * The env override exists only for test rigs (containment harness, e2e home
 * isolation, CDP verification) that must pin the legacy managed-home lane or
 * force the real-home lane inside a disposable HOME. It never appears in any
 * UI and no production path sets it.
 */
const CODEX_REAL_HOME_ENV_FLAG = 'ORCA_CODEX_SYSTEM_DEFAULT_REAL_HOME'

export function isCodexSystemDefaultRealHomeEnabled(): boolean {
  const envOverride = readCodexRealHomeEnvOverride()
  if (envOverride !== null) {
    return envOverride
  }
  return true
}

function readCodexRealHomeEnvOverride(): boolean | null {
  const raw = process.env[CODEX_REAL_HOME_ENV_FLAG]
  if (raw === undefined) {
    return null
  }
  const normalized = raw.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'on') {
    return true
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'off') {
    return false
  }
  return null
}
