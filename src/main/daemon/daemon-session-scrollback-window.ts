const DAEMON_SESSION_SCROLLBACK_ENV_VAR = 'ORCA_DAEMON_SESSION_SCROLLBACK_ROWS'

// Why a flat window and not full renderer depth: retained grid is the daemon's dominant heap term and
// session count is unbounded — a host owning 100+ terminals at full depth retained ~1 GB of grid and
// was OOM-killed, taking every session it owned with it. A terminal the user has open scrolls its full
// live renderer buffer; the daemon window is only what a REBUILD (reload, remount, restart, remote
// attach) restores, and 1000 rows is the generous end of what terminal products restore there.
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
