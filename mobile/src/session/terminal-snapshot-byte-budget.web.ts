import { BRIDGE_MAX_MESSAGE_BYTES } from '../mobile-web-shell/bridge/bridge-caps'
import { bridgeEventEnvelopeBytes } from '../mobile-web-shell/bridge/bridge-event-envelope-bytes'

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
 * not is a terminal that dies on a page it could have streamed. The envelope comes from the
 * protocol module, which is the one place the frame's shape is stated, so this and the shell's own
 * merge budget cannot drift apart.
 *
 * Everything inside `payload` is the desktop's to count, and it counts it by building the payload
 * it will publish rather than by summing the fields it remembers — which is what let a snapshot
 * accepted at exactly this budget arrive 169 bytes over the cap, on a frame carrying an
 * 8-character request id; a 24-character one is 247 over.
 */
export function mobileTerminalSnapshotByteBudget(): number | undefined {
  return BRIDGE_MAX_MESSAGE_BYTES - bridgeEventEnvelopeBytes()
}
