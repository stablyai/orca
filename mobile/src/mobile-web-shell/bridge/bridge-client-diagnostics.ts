import type { BridgeRefusal } from './bridge-caps'
import type { BridgeStreamEndReason } from './bridge-client-subscriptions'

/**
 * What the page saw and could not act on, in one vocabulary.
 *
 * Nothing here is recoverable in place; each is worth a line in a log and none is retried. It lives
 * beside the client rather than inside it because the frame reader raises most of these and the
 * client raises the rest, and a type one of them owned would make the other import it.
 */
export type BridgeRpcClientDiagnostic =
  | { kind: 'refused'; refusal: BridgeRefusal }
  | { kind: 'send-failed'; error: unknown }
  /** A frame the shell's own reader would have dropped, refused before it was posted. `bytes` is
   *  UTF-8 bytes, the unit both shells count the frame in. */
  | { kind: 'send-oversized'; bytes: number }
  | { kind: 'stream-ended'; reason: BridgeStreamEndReason }
  | { kind: 'stream-failed'; error: unknown }
  | { kind: 'state-out-of-order' }
  | { kind: 'binary-frame-dropped' }
  | { kind: 'unknown-id' }
