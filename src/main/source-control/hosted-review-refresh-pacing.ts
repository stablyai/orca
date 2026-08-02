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
