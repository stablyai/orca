import {
  MAX_DETACHED_LOOKUPS,
  MAX_UNSETTLED_LOOKUP_KEYS,
  MAX_UNSETTLED_LOOKUPS_PER_KEY
} from './hosted-review-refresh-pacing'

/**
 * Accounting for lookups that have not settled (P1-D).
 *
 * Nothing under the hosted-review funnel can be cancelled, so a lookup runs
 * until it settles — or forever, on a wedged host. Counting them is what stops
 * every deadline-plus-backoff cycle from stranding another one: past the cap the
 * branch answers unavailable instead of spawning a duplicate zombie.
 *
 * A branch reserves its slot when the lookup *starts*, not when the deadline
 * detaches it: an in-flight lookup the size cap dropped from the in-flight map is
 * just as unstoppable as a detached one, and admitting another for the same
 * branch alongside it would strand both.
 */
const unsettledByKey = new Map<string, number>()

/**
 * Detached work is counted process-wide too, because a wedged host wedges every
 * branch on it. In-flight lookups are deliberately left out of this total: they
 * are the ordinary fan-out of a client polling its worktree list, and capping
 * those at 64 would fail legitimate lookups on any machine with more branches.
 */
let detachedTotal = 0

/** Reserves the branch's slot for a lookup that is about to start. */
export function noteLookupStarted(key: string): void {
  unsettledByKey.set(key, (unsettledByKey.get(key) ?? 0) + 1)
}

/** The deadline gave up on this lookup; it runs on, and stays counted. */
export function noteDetachedLookup(): void {
  detachedTotal += 1
}

/** Called when a lookup finally settles, freeing its branch slot. */
export function settleLookup(key: string): void {
  const remaining = (unsettledByKey.get(key) ?? 0) - 1
  if (remaining > 0) {
    unsettledByKey.set(key, remaining)
  } else {
    unsettledByKey.delete(key)
  }
}

/** Called when a detached lookup settles, freeing its process-wide slot. */
export function settleDetachedLookup(): void {
  detachedTotal = Math.max(0, detachedTotal - 1)
}

/**
 * Why this branch cannot start a lookup, or null when it can. Only the per-branch
 * cap may blame an attempt of its own: the other two hold back branches that have
 * never asked for anything, and telling those users to wait on a lookup they
 * never started sends them looking for a stall that is not theirs.
 */
export function lookupCapacityRefusal(key: string): string | null {
  if ((unsettledByKey.get(key) ?? 0) >= MAX_UNSETTLED_LOOKUPS_PER_KEY) {
    return 'Hosted review lookup is still running from an earlier attempt that never answered. It will be retried once that attempt settles.'
  }
  // Why: this map is bounded by refusing new branches, not by evicting old ones —
  // its entries are lookups still out there, and dropping a key would re-admit
  // one for a branch already wedged. The bound sits above the in-flight cap so a
  // wave wide enough to reach it is pathological, not the ordinary fan-out of a
  // client polling a long worktree list.
  if (!unsettledByKey.has(key) && unsettledByKey.size >= MAX_UNSETTLED_LOOKUP_KEYS) {
    return 'Too many hosted review lookups are already in progress to start another. This branch will be retried once some of them settle.'
  }
  if (detachedTotal >= MAX_DETACHED_LOOKUPS) {
    return 'Too many hosted review lookups have been abandoned without answering. This branch will be retried once the host catches up.'
  }
  return null
}

/** @internal - exposed for tests only */
export function __resetUnsettledHostedReviewLookupsForTests(): void {
  unsettledByKey.clear()
  detachedTotal = 0
}
