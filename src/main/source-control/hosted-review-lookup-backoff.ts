import {
  lookupBackoffDelayMs,
  LOOKUP_BACKOFF_MAX_MS,
  MAX_BRANCH_MAP_ENTRIES
} from './hosted-review-refresh-pacing'

/**
 * Per-branch failure escalation for hosted-review lookups (#11532).
 *
 * Split out of the branch cache so the cache file stays about caching: this map
 * has its own lifetime — a branch stays backed off after its cached answer is
 * invalidated, and it is what a lookup deadline records against (P1-D).
 */

/** Bounded like the answer cache, so a churn of dead branches cannot grow it. */
const MAX_BACKOFF_ENTRIES = MAX_BRANCH_MAP_ENTRIES

const failureBackoff = new Map<string, { until: number; failures: number }>()

export function backoffUntil(key: string): number | null {
  // Why: a lapsed window keeps its failure count, otherwise the very act of
  // retrying resets the escalation and the backoff never grows past the base.
  const entry = failureBackoff.get(key)
  return entry !== undefined && entry.until > Date.now() ? entry.until : null
}

export function noteFailure(key: string): void {
  const now = Date.now()
  for (const [candidate, entry] of failureBackoff) {
    // Why: only counts that lapsed a full max window ago are stale enough to
    // forget; anything more eager would undo the escalation above.
    if (now - entry.until > LOOKUP_BACKOFF_MAX_MS) {
      failureBackoff.delete(candidate)
    }
  }
  const failures = (failureBackoff.get(key)?.failures ?? 0) + 1
  failureBackoff.delete(key)
  failureBackoff.set(key, { until: now + lookupBackoffDelayMs(failures), failures })
  while (failureBackoff.size > MAX_BACKOFF_ENTRIES) {
    const oldest = failureBackoff.keys().next().value
    if (oldest === undefined) {
      break
    }
    failureBackoff.delete(oldest)
  }
}

/** A lookup answered, so the branch starts its next escalation from the base. */
export function clearFailures(key: string): void {
  failureBackoff.delete(key)
}

export function dropFailuresWithPrefix(prefix: string): void {
  for (const key of failureBackoff.keys()) {
    if (key.startsWith(prefix)) {
      failureBackoff.delete(key)
    }
  }
}

/** @internal - exposed for tests only */
export function __resetHostedReviewLookupBackoffForTests(): void {
  failureBackoff.clear()
}
