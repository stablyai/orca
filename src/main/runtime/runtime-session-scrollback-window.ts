const RUNTIME_SESSION_SCROLLBACK_ENV_VAR = 'ORCA_RUNTIME_SESSION_SCROLLBACK_ROWS'

// Why a flat live window: the runtime's per-PTY headless mirror has the same
// retained-grid failure mode the daemon already hit (daemon-session-scrollback-window.ts:
// a host owning 100+ terminals at full depth retained ~1 GB of grid and was OOM-killed).
// This mirror never feeds the desktop renderer — deep scrollback there is the renderer's
// live buffer, mobile seeds are already capped at MOBILE_SUBSCRIBE_SCROLLBACK_ROWS, and
// rebuilds restore from durable history. Keep the default and override bounds in sync
// with the daemon twin.
export const RUNTIME_SESSION_SCROLLBACK_ROWS = 1000
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
