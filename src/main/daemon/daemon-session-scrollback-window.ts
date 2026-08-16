const DAEMON_SESSION_SCROLLBACK_ENV_VAR = 'ORCA_DAEMON_SESSION_SCROLLBACK_ROWS'

// Why a flat live window and not full renderer depth: retained grid is the daemon's dominant heap
// term and session count is unbounded — a host owning 100+ terminals at full depth retained ~1 GB
// of grid and was OOM-killed, taking every session it owned with it. A terminal the user has open
// scrolls its full live renderer buffer. Rebuilds (reload, remount, restart, remote attach) restore
// from durable history at DAEMON_RESTORE_SCROLLBACK_ROWS, not this live RAM window.
export const DAEMON_SESSION_SCROLLBACK_ROWS = 1000
// Why: keep any override within sane terminal bounds — 0 would lose the visible screen's context and
// huge values silently reintroduce the unbounded-retention failure this window exists to prevent.
const MIN_OVERRIDE_ROWS = 100
const MAX_OVERRIDE_ROWS = 5000

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
