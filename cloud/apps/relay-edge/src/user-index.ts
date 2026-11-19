// The host object's side of the erasure index (user-hosts.ts). Dark: only the edge-native
// director's assign writes it, and only while the director endpoints are configured
// (DIRECTOR_HOSTNAME, director-config.ts); no other path touches the pending marker.
// The marker is written before any call, so a failed or interrupted write is retried from the
// object's alarm until the index acknowledges it. Per user it keeps only the latest wanted state
// (an add or a remove), so a host that switches accounts back and forth converges.

export const USER_INDEX_PENDING_KEY = 'userIndexPending'
export const USER_INDEX_RETRY_MIN_MS = 30_000
export const USER_INDEX_RETRY_MAX_MS = 60 * 60 * 1000

export type UserIndexOp = 'add' | 'remove'
export type UserIndexPending = {
  relayHostId: string
  ops: Record<string, UserIndexOp>
  // Failed attempts so far, and when the alarm tries next.
  attempts: number
  retryAt: number
}

// The index writes one director-native assign needs: the asking user holds the host; on an
// account switch the earlier user no longer does. `previousUserId` null: no earlier owner.
export function userIndexOps(userId: string, previousUserId: string | null): Record<string, UserIndexOp> {
  const ops: Record<string, UserIndexOp> = {}
  if (previousUserId !== null && previousUserId !== userId) { ops[previousUserId] = 'remove' }
  ops[userId] = 'add'
  return ops
}

// Merges new writes into what is still pending. Due at once: the alarm makes the first attempt,
// so the client's assign never waits on the index.
export function mergePending(
  pending: UserIndexPending | undefined,
  relayHostId: string,
  ops: Record<string, UserIndexOp>,
  now: number
): UserIndexPending {
  const kept = pending?.relayHostId === relayHostId ? pending.ops : {}
  return { relayHostId, ops: { ...kept, ...ops }, attempts: 0, retryAt: now }
}

// After a failed attempt: only the ops still unacknowledged, retried with capped backoff.
export function afterFailure(pending: UserIndexPending, remaining: Record<string, UserIndexOp>, now: number): UserIndexPending {
  const attempts = pending.attempts + 1
  const delay = Math.min(USER_INDEX_RETRY_MIN_MS * 2 ** (attempts - 1), USER_INDEX_RETRY_MAX_MS)
  return { ...pending, ops: remaining, attempts, retryAt: now + delay }
}
