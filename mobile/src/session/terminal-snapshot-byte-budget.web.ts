import { BRIDGE_MAX_MESSAGE_BYTES } from '../mobile-web-shell/bridge/bridge-caps'
import {
  BRIDGE_ID_PATTERN,
  BRIDGE_PROTOCOL_VERSION
} from '../mobile-web-shell/bridge/bridge-envelope'

/**
 * The widest bridge id, read off the pattern that admits it rather than counted by eye.
 *
 * The pattern is a fixed-length class, so its own quantifier is the length: a change to it moves
 * this number instead of leaving a budget that was right for the id the protocol used to carry.
 */
function bridgeIdChars(): number {
  const quantifier = /\{(\d+)\}\$$/.exec(BRIDGE_ID_PATTERN.source)
  // A pattern that stopped being fixed-length is not a bound this can derive, and guessing one is
  // how a budget silently stops covering the frame it was written for.
  if (quantifier === null) {
    throw new Error('the bridge id pattern is no longer a fixed length')
  }
  return Number(quantifier[1])
}

/**
 * What the event frame costs around the payload, derived rather than typed.
 *
 * Everything the shell writes outside `payload`: the version, the frame kind, a full-length id and
 * the backpressure counter at the largest integer it can hold. A JSON object costs two braces and
 * one colon and comma per key, all of which `JSON.stringify` of the skeleton already counts, and
 * `payload: {}` leaves the two braces of the payload object itself in the bound — which is right,
 * because the snapshot's own object needs them.
 *
 * What it does not cover is the payload's fixed-width metadata, and that is the desktop's to count
 * rather than this side's to predict: `cwd`, the OSC-link list and the pending escape tail have no
 * ceiling a client knows, and they are exactly the fields the host is holding while it decides how
 * much scrollback to send. So the host measures its own metadata against what is left here.
 */
export function bridgeEventEnvelopeBytes(): number {
  return JSON.stringify({
    v: BRIDGE_PROTOCOL_VERSION,
    type: 'event',
    id: 'a'.repeat(bridgeIdChars()),
    seq: Number.MAX_SAFE_INTEGER,
    payload: {}
  }).length
}

/**
 * Web sibling: one bridge frame, less what the frame costs around it.
 *
 * The shell measures the serialized event against `BRIDGE_MAX_MESSAGE_BYTES` and ends the stream
 * with `overflow` when it does not fit, which for a terminal means the pane dies before its first
 * live byte with no recovery that would not reproduce it. Measured here: the 512 KiB raw budget
 * hands back a 465,766-byte colour-dense 80-column snapshot that serializes to 669,268 bytes,
 * 102.1% of the cap, because every ESC byte becomes six.
 *
 * Computed from the cap rather than written down beside it: a cap that moves and a budget that does
 * not is a terminal that dies on a page it could have streamed.
 */
export function mobileTerminalSnapshotByteBudget(): number | undefined {
  return BRIDGE_MAX_MESSAGE_BYTES - bridgeEventEnvelopeBytes()
}
