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
  /**
   * A frame the page received and then failed to handle: one of its own listeners threw.
   *
   * Not a lost frame, and not the channel's failure. On iOS the host's post is
   * `callAsyncJavaScript`, so a throw out of the page's synchronous `onmessage` rejects the post
   * with the document still mounted — which the shell would read as a frame that never arrived,
   * and the shell tracks nothing about posts (ruling 34). The page had it, so the page says so,
   * and nothing is retried: the listener would throw on the same frame again.
   */
  | { kind: 'inbound-listener-threw'; error: unknown }
  /**
   * A Back press the shell handed over that nothing in this document took.
   *
   * The claim and the press cross on separate frames, so a sheet that closed between the two leaves
   * the shell holding a claim this page no longer has anything to spend. The press is handed back
   * as a `navigate-back` rather than dropped — a key that does nothing is the failure this whole
   * lane exists to remove — and this line is the only trace that the round trip was wasted.
   */
  | { kind: 'back-unclaimed' }
