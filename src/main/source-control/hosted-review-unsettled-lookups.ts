import {
  MAX_DETACHED_LOOKUPS,
  MAX_UNSETTLED_LOOKUP_KEYS,
  MAX_UNSETTLED_LOOKUPS_PER_KEY
} from './hosted-review-refresh-pacing'

/** Count uninterruptible lookups from start, including size-evicted owners; deadlines release callers without freeing running work (P1-D). */
const unsettledByKey = new Map<string, number>()

/** Cap detached work process-wide; ordinary in-flight fan-out must not spend that budget. */
let detachedTotal = 0

export function noteLookupStarted(key: string): void {
  unsettledByKey.set(key, (unsettledByKey.get(key) ?? 0) + 1)
}

/** The deadline gave up on this lookup; it runs on, and stays counted. */
export function noteDetachedLookup(): void {
  detachedTotal += 1
}

export function settleLookup(key: string): void {
  const remaining = (unsettledByKey.get(key) ?? 0) - 1
  if (remaining > 0) {
    unsettledByKey.set(key, remaining)
  } else {
    unsettledByKey.delete(key)
  }
}

export function settleDetachedLookup(): void {
  detachedTotal = Math.max(0, detachedTotal - 1)
}

/** Only branch-local capacity may blame that branch's pending request; global limits must not invent an attempt for fresh callers. */
export function lookupCapacityRefusal(key: string): string | null {
  if ((unsettledByKey.get(key) ?? 0) >= MAX_UNSETTLED_LOOKUPS_PER_KEY) {
    return 'Hosted review lookup is still running from an earlier attempt that never answered. It will be retried once that attempt settles.'
  }
  // Refuse new keys rather than evict running-work evidence; otherwise wedged branches could reenter. Bound above normal in-flight fan-out.
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
