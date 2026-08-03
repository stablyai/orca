// Why: a scan that expired its budget still made progress — the parse cache
// retains what it finished, so the next scan resumes further down the list. A
// scan killed by a crash loop, a timeout loop, or a worker that will not spawn
// made none, and retrying it every cache-TTL just re-burns a core on work that
// cannot succeed. Only those hard failures back off, and only process-wide.
const COOLDOWN_BASE_MS = 60_000
const COOLDOWN_MAX_MS = 10 * 60_000

let cooldownUntilMs = 0
let consecutiveHardFailures = 0

export function noteOpenCodeSqliteScanHardFailure(nowMs = Date.now()): void {
  consecutiveHardFailures += 1
  const backoffMs = Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** (consecutiveHardFailures - 1))
  cooldownUntilMs = Math.max(cooldownUntilMs, nowMs + backoffMs)
}

/** A scan that finished its SQLite work clears the backoff. */
export function noteOpenCodeSqliteScanProgress(): void {
  consecutiveHardFailures = 0
  cooldownUntilMs = 0
}

export function openCodeSqliteScanCooldownRemainingMs(nowMs = Date.now()): number {
  return Math.max(0, cooldownUntilMs - nowMs)
}

export function resetOpenCodeSqliteScanCooldownForTests(): void {
  cooldownUntilMs = 0
  consecutiveHardFailures = 0
}
