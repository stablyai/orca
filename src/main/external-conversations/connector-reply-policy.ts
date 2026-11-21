// How long reply recovery keeps a request's answer worth posting (design: slack-reply-lost-restart).
// Each is a product tradeoff, deliberately conservative and named so it can be tuned in one place.

/** A recovered answer posts only if the turn that resolved it ended at most this long before the
 *  fill. Longer means a stale answer reaches a thread that has moved on; shorter loses a long
 *  restart's answer. */
export const REPLY_FRESH_MS = 60 * 60_000

/** A request older than this when recovery settles it is closed quietly, however fresh its answer. */
export const REPLY_REQUEST_MAX_AGE_MS = 24 * 60 * 60_000

/** An interrupted turn's requests wait for its restart continuation at most this long after the
 *  interruption, even while a restart offer still stands. */
export const REPLY_HOLD_MAX_MS = 24 * 60 * 60_000

/** A continuation of a continuation is followed this many times, no further. */
export const RESTART_CHAIN_MAX = 4

export type ReplyPolicy = {
  freshMs: number
  requestMaxAgeMs: number
  holdMaxMs: number
  chainMax: number
}

export const REPLY_POLICY: ReplyPolicy = {
  freshMs: REPLY_FRESH_MS,
  requestMaxAgeMs: REPLY_REQUEST_MAX_AGE_MS,
  holdMaxMs: REPLY_HOLD_MAX_MS,
  chainMax: RESTART_CHAIN_MAX
}

/** Why a row was settled quietly: its answer or its request was too old, or a mirrored
 *  continuation already tells the thread. Local only (expired_reason), never sent. */
export type ReplyExpiry =
  | { kind: 'stale_answer'; resolvedAt: number }
  | { kind: 'old_request'; admittedAt: number }
  | { kind: 'unknown_age' }
  | { kind: 'continuation_mirrored' }

export function replyExpiryReason(expiry: ReplyExpiry, outcome: string, now: number): string {
  const at = (ms: number) => new Date(ms).toISOString()
  switch (expiry.kind) {
    case 'stale_answer':
      return `stale_answer: ${outcome} resolved at ${at(expiry.resolvedAt)}, filled at ${at(now)}`
    case 'old_request':
      return `old_request: ${outcome} for a request admitted at ${at(expiry.admittedAt)}, filled at ${at(now)}`
    case 'unknown_age':
      return `unknown_age: ${outcome}, filled at ${at(now)}`
    case 'continuation_mirrored':
      return 'continuation_mirrored'
  }
}

/** Whether a recovered fill may post: its resolving event and its request are both recent enough.
 *  resolvedAt undefined: an outcome with no end time of its own (judged by request age alone). */
export function replyExpiry(
  input: { resolvedAt: number | undefined; admittedAt: number | undefined; now: number },
  policy: ReplyPolicy = REPLY_POLICY
): ReplyExpiry | null {
  const { resolvedAt, admittedAt, now } = input
  if (admittedAt === undefined) {
    return { kind: 'unknown_age' }
  }
  if (now - admittedAt > policy.requestMaxAgeMs) {
    return { kind: 'old_request', admittedAt }
  }
  if (resolvedAt !== undefined && now - resolvedAt > policy.freshMs) {
    return { kind: 'stale_answer', resolvedAt }
  }
  return null
}
