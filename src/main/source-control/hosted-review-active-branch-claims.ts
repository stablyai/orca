import { ACTIVE_CLAIM_TTL_MS, MAX_ACTIVE_BRANCHES } from './hosted-review-refresh-pacing'

/** Track selection separately from cached answers: active branches earn per-minute pacing (#11532). */
const activeClaims = new Map<string, number>()

/** Report newly active selection; LRU bounds the fast tier across client claims. */
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
