// Refresh tokens whose server-side fate is unknown: the POST left the client but
// no status came back, so the server may already have rotated the token before
// the reply was lost. Sending it again reads as reuse and revokes the whole
// token family — on 2026-09-04 that turned one slow refresh endpoint into 21,605
// sign-outs, because every caller's retry loop replayed the same stored token.

// A replay this soon after the ambiguous attempt is a retry loop, not a person
// asking again; holding it back keeps one lost reply from becoming a storm.
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

// Call once the token's fate is known: it rotated, or the session it belonged to
// is gone. Leaving the record would mislabel a later, unrelated 401.
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
    // Keep the evidence separate from the temporary block so a later 401 can
    // still be classified as a possible replay after the window expires.
    ambiguousRefreshAttempts.delete(key)
    expiredAmbiguousRefreshAttempts.set(key, attempt)
    pruneAmbiguousRefreshAttempts(now)
    return false
  }
  pruneAmbiguousRefreshAttempts(now, key)
  // Why bounded rather than permanent: the token is only *possibly* spent. A
  // permanent block would sign out every desktop whose refresh merely timed out.
  return now - attempt.attemptedAt < AMBIGUOUS_REFRESH_REPLAY_DELAY_MS
}
