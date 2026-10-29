/** PR refresh and hosted-review RPC spend one API quota; share TTL/backoff policy (#11532). */

/** Review creation is infrequent; avoid per-minute polling for absent reviews. */
export const NO_REVIEW_REFRESH_INTERVAL_MS = 15 * 60_000

/** Selection earns a fast tier so externally opened reviews appear while the tab is active. */
export const ACTIVE_REFRESH_INTERVAL_MS = 60_000

/** Bound active claims: misbehaving O(N) callers must lose freshness rather than exhaust quota. */
export const MAX_ACTIVE_BRANCHES = 8

/** A selection nobody has re-asserted for a whole no-review interval is not current. */
export const ACTIVE_CLAIM_TTL_MS = NO_REVIEW_REFRESH_INTERVAL_MS

export const LOOKUP_BACKOFF_BASE_MS = 60_000
export const LOOKUP_BACKOFF_MAX_MS = 15 * 60_000

/** Detect hangs across chained bounded operations; this is a total hang deadline, not a latency target. */
export const HOSTED_REVIEW_LOOKUP_DEADLINE_MS = 2 * 60_000

/** Keep answer, generation and backoff maps under the same branch-count bound. */
export const MAX_BRANCH_MAP_ENTRIES = 500

/** Memory backstop only: live eviction costs duplicate API calls, so exceed realistic polling concurrency. */
export const MAX_INFLIGHT_LOOKUPS = MAX_BRANCH_MAP_ENTRIES

/** Uninterruptible calls count from start; allow one recovery retry per branch, then refuse more stranded work. */
export const MAX_UNSETTLED_LOOKUPS_PER_KEY = 2

/** Bound new unsettled keys above in-flight eviction so ordinary fan-out evicts before admission refuses. */
export const MAX_UNSETTLED_LOOKUP_KEYS = 2 * MAX_BRANCH_MAP_ENTRIES

export const MAX_DETACHED_LOOKUPS = 64

// Why: capped so a long-lived failure settles at LOOKUP_BACKOFF_MAX_MS rather
// than overflowing the exponent.
const MAX_BACKOFF_DOUBLINGS = 4

export function lookupBackoffDelayMs(failures: number): number {
  return Math.min(
    LOOKUP_BACKOFF_MAX_MS,
    LOOKUP_BACKOFF_BASE_MS * 2 ** Math.min(Math.max(failures, 1) - 1, MAX_BACKOFF_DOUBLINGS)
  )
}
