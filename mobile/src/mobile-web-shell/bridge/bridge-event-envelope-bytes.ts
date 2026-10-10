import { BRIDGE_ID_PATTERN, BRIDGE_PROTOCOL_VERSION } from './bridge-envelope'

/**
 * What an `event` frame costs around its payload, in one place because two budgets read it.
 *
 * Split out of `bridge-envelope.ts` rather than added to it: that file is the protocol's schemas
 * and it is at its line cap, and this is a derivation over them rather than one of them.
 */

/**
 * The widest bridge id, read off the pattern that admits it rather than counted by eye.
 *
 * The pattern is a fixed-length class, so its own quantifier is the length: a change to it moves
 * this number instead of leaving a budget that was right for the id the protocol used to carry.
 */
export function bridgeIdChars(): number {
  const quantifier = /\{(\d+)\}\$$/.exec(BRIDGE_ID_PATTERN.source)
  // A pattern that stopped being fixed-length is not a bound anything can derive, and guessing one
  // is how a budget silently stops covering the frame it was written for.
  if (quantifier === null) {
    throw new Error('the bridge id pattern is no longer a fixed length')
  }
  return Number(quantifier[1])
}

/**
 * What an `event` frame costs around its payload, at the widest every field can be written.
 *
 * One statement of the frame's shape, because there are two readers of it and they must not
 * disagree: the page sizes the snapshot it asks the desktop for against this, and the shell sizes
 * the terminal output it merges against it. Two skeletons would be two bounds, and the one that
 * drifted would be discovered as a stream that ended.
 *
 * `id` at its full width and `seq` at the largest integer it can hold, because both appear in every
 * frame and neither is known when a budget is computed. `payload: 0` leaves the key, its colon and
 * the comma in the count and nothing else, so what is left over is exactly what the payload's own
 * serialization may occupy.
 */
export function bridgeEventEnvelopeBytes(id = 'a'.repeat(bridgeIdChars())): number {
  return JSON.stringify({
    v: BRIDGE_PROTOCOL_VERSION,
    type: 'event',
    id,
    seq: Number.MAX_SAFE_INTEGER,
    payload: 0
  }).length
}
