import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT } from '../../shared/terminal-scrollback-policy'

const RUNTIME_SESSION_SCROLLBACK_ENV_VAR = 'ORCA_RUNTIME_SESSION_SCROLLBACK_ROWS'

// Why a bounded window: retained grid is this process's dominant per-PTY heap
// term; the daemon twin (daemon-session-scrollback-window.ts) was OOM-killed at
// full depth with 100+ terminals. Unlike the daemon, this mirror also serves
// desktop hidden-output recovery — serializeHiddenOutputRecoveryBuffer prefers
// it when a parked pane is revealed, at the user's configured depth — so the
// default must cover the desktop default rather than silently truncate it.
// Hosts short on RAM trade recovery depth via the env override. Mobile seeds
// stay capped at MOBILE_SUBSCRIBE_SCROLLBACK_ROWS; rebuilds restore from
// durable history.
export const RUNTIME_SESSION_SCROLLBACK_ROWS = DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT
// Why: keep any override within sane terminal bounds — 0 would lose the visible screen's
// context and huge values silently reintroduce the unbounded retention this window prevents.
const MIN_OVERRIDE_ROWS = 100
const MAX_OVERRIDE_ROWS = 5000

export function resolveRuntimeSessionScrollbackRows(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[RUNTIME_SESSION_SCROLLBACK_ENV_VAR]?.trim()
  if (!raw || !/^\d+$/.test(raw)) {
    return RUNTIME_SESSION_SCROLLBACK_ROWS
  }
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < MIN_OVERRIDE_ROWS || parsed > MAX_OVERRIDE_ROWS) {
    return RUNTIME_SESSION_SCROLLBACK_ROWS
  }
  return parsed
}
