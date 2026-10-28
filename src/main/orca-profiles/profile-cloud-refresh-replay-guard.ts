// Lost refresh replies may have rotated the token; replay can revoke the entire token family.

// Briefly block retry loops after ambiguous rotation to avoid replay storms.
export const AMBIGUOUS_REFRESH_REPLAY_DELAY_MS = 30_000
const AMBIGUOUS_REFRESH_ATTEMPTS_MAX_ENTRIES = 512

type AmbiguousRefreshAttempt = {
  refreshToken: string
  attemptedAt: number
}

const ambiguousRefreshAttempts = new Map<string, AmbiguousRefreshAttempt>()
const expiredAmbiguousRefreshAttempts = new Map<string, AmbiguousRefreshAttempt>()

function pruneAmbiguousRefreshAttempts(now: number, preserveKey?: string): void {
  for (const [key, attempt] of ambiguousRefreshAttempts) {
    if (key === preserveKey) {
      continue
    }
    if (now - attempt.attemptedAt >= AMBIGUOUS_REFRESH_REPLAY_DELAY_MS) {
      ambiguousRefreshAttempts.delete(key)
      expiredAmbiguousRefreshAttempts.set(key, attempt)
    }
  }
  while (expiredAmbiguousRefreshAttempts.size > AMBIGUOUS_REFRESH_ATTEMPTS_MAX_ENTRIES) {
    const oldest = expiredAmbiguousRefreshAttempts.keys().next()
    if (oldest.done) {
      return
    }
    expiredAmbiguousRefreshAttempts.delete(oldest.value)
  }
  while (ambiguousRefreshAttempts.size > AMBIGUOUS_REFRESH_ATTEMPTS_MAX_ENTRIES) {
    const oldest = ambiguousRefreshAttempts.keys().next()
    if (oldest.done) {
      return
    }
    ambiguousRefreshAttempts.delete(oldest.value)
  }
}

export class AmbiguousRefreshReplayBlockedError extends Error {
  constructor() {
    super('orca_cloud_refresh_replay_blocked')
    this.name = 'AmbiguousRefreshReplayBlockedError'
  }
}

export function recordAmbiguousRefreshAttempt(
  key: string,
  refreshToken: string,
  now = Date.now()
): void {
  pruneAmbiguousRefreshAttempts(now)
  ambiguousRefreshAttempts.delete(key)
  expiredAmbiguousRefreshAttempts.delete(key)
  ambiguousRefreshAttempts.set(key, { refreshToken, attemptedAt: now })
  pruneAmbiguousRefreshAttempts(now)
}

// Forget resolved token fates so later unrelated 401s are not misclassified.
export function forgetAmbiguousRefreshAttempt(key: string): void {
  ambiguousRefreshAttempts.delete(key)
  expiredAmbiguousRefreshAttempts.delete(key)
}

export function wasRefreshTokenAmbiguouslyAttempted(key: string, refreshToken: string): boolean {
  return (
    ambiguousRefreshAttempts.get(key)?.refreshToken === refreshToken ||
    expiredAmbiguousRefreshAttempts.get(key)?.refreshToken === refreshToken
  )
}

export function blocksAmbiguousRefreshReplay(
  key: string,
  refreshToken: string,
  now = Date.now()
): boolean {
  const attempt = ambiguousRefreshAttempts.get(key)
  if (!attempt || attempt.refreshToken !== refreshToken) {
    pruneAmbiguousRefreshAttempts(now)
    return false
  }
  if (now < attempt.attemptedAt) {
    // A clock rollback must not resurrect an already-expired replay window.
    ambiguousRefreshAttempts.delete(key)
    return false
  }
  if (now - attempt.attemptedAt >= AMBIGUOUS_REFRESH_REPLAY_DELAY_MS) {
    // Retain evidence after unblocking so later 401s can still be classified as possible replay.
    ambiguousRefreshAttempts.delete(key)
    expiredAmbiguousRefreshAttempts.set(key, attempt)
    pruneAmbiguousRefreshAttempts(now)
    return false
  }
  pruneAmbiguousRefreshAttempts(now, key)
  // A permanent block would sign out users whose token was never spent.
  return now - attempt.attemptedAt < AMBIGUOUS_REFRESH_REPLAY_DELAY_MS
}
