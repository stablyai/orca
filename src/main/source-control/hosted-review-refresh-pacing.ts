/**
 * Shared pacing policy for hosted-review lookups (#11532).
 *
 * The PR refresh coordinator's queue and the `hostedReview:forBranch` entry
 * point spend the same per-user API quota, so they must agree on how long an
 * answer stays good and how hard to back off after a failure. Keeping the
 * numbers here stops the two paths from drifting apart.
 */

/** A branch with no review only gains one when a review is opened, which is not a per-minute event. */
export const NO_REVIEW_REFRESH_INTERVAL_MS = 15 * 60_000

/**
 * The worktree the user has selected is re-checked at the old cadence: a review
 * opened in a browser should show up while they are still looking at the tab.
 */
export const ACTIVE_REFRESH_INTERVAL_MS = 60_000

/**
 * Why: the fast tier is only affordable because it is O(1) — one selected
 * worktree per client. Capping it here means a caller that wrongly marks a whole
 * list active costs stale cards, not the 5,000/hr budget.
 */
export const MAX_ACTIVE_BRANCHES = 8

/** A selection nobody has re-asserted for a whole no-review interval is not current. */
export const ACTIVE_CLAIM_TTL_MS = NO_REVIEW_REFRESH_INTERVAL_MS

export const LOOKUP_BACKOFF_BASE_MS = 60_000
export const LOOKUP_BACKOFF_MAX_MS = 15 * 60_000

/**
 * Hard deadline for a single lookup. The steps underneath are individually
 * bounded (30s `gh` exec, HTTP timeouts) but they chain, so this is a hang
 * detector rather than a latency budget: a lookup that outlives it is wedged on
 * something that has no timeout of its own, not merely slow.
 */
export const HOSTED_REVIEW_LOOKUP_DEADLINE_MS = 2 * 60_000

/**
 * Single bound for every branch-keyed map in this subsystem — cached answers,
 * scope generations and failure backoff. One knob, so tuning one map cannot
 * silently leave the others behind.
 */
export const MAX_BRANCH_MAP_ENTRIES = 500

/**
 * Why: a memory backstop, not a concurrency limit. Evicting a live lookup costs
 * a duplicate provider call — the quota problem this cache exists to prevent —
 * so the cap must stay far above the branch count any client polls at once.
 */
export const MAX_INFLIGHT_LOOKUPS = MAX_BRANCH_MAP_ENTRIES

/**
 * A lookup cannot be cancelled, so one that never settles is stranded for the
 * life of the process. Two per branch — counted from the moment a lookup starts,
 * not from the deadline — leaves room for the retry that proves a host
 * recovered; past that the branch is wedged, not slow, and asking again only
 * strands another provider call.
 */
export const MAX_UNSETTLED_LOOKUPS_PER_KEY = 2

/** Process-wide backstop for the same leak when many branches wedge at once. */
export const MAX_DETACHED_LOOKUPS = 64

// Why: capped so a long-lived failure settles at LOOKUP_BACKOFF_MAX_MS rather
// than overflowing the exponent.
const MAX_BACKOFF_DOUBLINGS = 4

/** Exponential backoff delay for the nth consecutive lookup failure (1-based). */
export function lookupBackoffDelayMs(failures: number): number {
  return Math.min(
    LOOKUP_BACKOFF_MAX_MS,
    LOOKUP_BACKOFF_BASE_MS * 2 ** Math.min(Math.max(failures, 1) - 1, MAX_BACKOFF_DOUBLINGS)
  )
}
