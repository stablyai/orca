import { ACTIVE_CLAIM_TTL_MS, MAX_ACTIVE_BRANCHES } from './hosted-review-refresh-pacing'

/**
 * The branches callers report as their current selection (#11532).
 *
 * Split from the answer cache because it is a different question: not "what is
 * this branch's review" but "is anyone looking at it", which is what buys the
 * per-minute tier.
 */
const activeClaims = new Map<string, number>()

/**
 * Records the caller's current selection, reporting whether the branch was not
 * already active. Claims are least-recently-used so the fast tier stays bounded
 * no matter how many a client asserts.
 */
export function noteActiveClaim(key: string): boolean {
  const now = Date.now()
  for (const [candidate, claimedAt] of activeClaims) {
    if (now - claimedAt > ACTIVE_CLAIM_TTL_MS) {
      activeClaims.delete(candidate)
    }
  }
  const wasActive = activeClaims.has(key)
  activeClaims.delete(key)
  activeClaims.set(key, now)
  while (activeClaims.size > MAX_ACTIVE_BRANCHES) {
    const oldest = activeClaims.keys().next().value
    if (oldest === undefined) {
      break
    }
    activeClaims.delete(oldest)
  }
  return !wasActive
}

export function isActiveBranch(key: string): boolean {
  const claimedAt = activeClaims.get(key)
  return claimedAt !== undefined && Date.now() - claimedAt <= ACTIVE_CLAIM_TTL_MS
}

/** @internal - exposed for tests only */
export function __resetHostedReviewActiveClaimsForTests(): void {
  activeClaims.clear()
}
