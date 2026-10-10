/** Kept dependency-free: the short-lived stop-completion command imports these too. */
export const ORCAD_SHUTDOWN_DEADLINE_MS = 15_000
export const ORCAD_DAEMON_RETIREMENT_TIMEOUT_MS = 5_000

export const ORCAD_STOP_COMPLETION_POLL_MS = 250
// Retirement (request + session count, each bounded) runs before the shutdown deadline starts.
const STOP_COMPLETION_BUDGET_MS =
  2 * ORCAD_DAEMON_RETIREMENT_TIMEOUT_MS + ORCAD_SHUTDOWN_DEADLINE_MS + 5_000
export const ORCAD_STOP_COMPLETION_POLL_ATTEMPTS = Math.ceil(
  STOP_COMPLETION_BUDGET_MS / ORCAD_STOP_COMPLETION_POLL_MS
)
