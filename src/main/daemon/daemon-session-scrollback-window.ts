import { DAEMON_RESTORE_SCROLLBACK_ROWS } from './daemon-restore-scrollback-depth'
const DAEMON_SESSION_SCROLLBACK_ENV_VAR = 'ORCA_DAEMON_SESSION_SCROLLBACK_ROWS'

// Bound live grid memory across many terminals; durable history supplies the deeper restore window.
export const DAEMON_SESSION_SCROLLBACK_ROWS = 1000
// Reject zero-context and oversized windows that defeat bounded retention.
const MIN_OVERRIDE_ROWS = 100
const MAX_OVERRIDE_ROWS = DAEMON_RESTORE_SCROLLBACK_ROWS

export function resolveDaemonSessionScrollbackRows(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DAEMON_SESSION_SCROLLBACK_ENV_VAR]?.trim()
  if (!raw || !/^\d+$/.test(raw)) {
    return DAEMON_SESSION_SCROLLBACK_ROWS
  }
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < MIN_OVERRIDE_ROWS || parsed > MAX_OVERRIDE_ROWS) {
    return DAEMON_SESSION_SCROLLBACK_ROWS
  }
  return parsed
}
