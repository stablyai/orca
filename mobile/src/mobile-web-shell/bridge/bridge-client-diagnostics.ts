import type { BridgeRefusal } from './bridge-caps'
import type { BridgeStreamEndReason } from './bridge-client-subscriptions'

export type BridgeRpcClientDiagnostic =
  | { kind: 'refused'; refusal: BridgeRefusal }
  | { kind: 'send-failed'; error: unknown }
  // Refuse before posting frames the shell would drop; bytes uses the native shells’ UTF-8 unit.
  | { kind: 'send-oversized'; bytes: number }
  | { kind: 'stream-ended'; reason: BridgeStreamEndReason }
  | { kind: 'stream-failed'; error: unknown }
  | { kind: 'state-out-of-order' }
  | { kind: 'binary-frame-dropped' }
  | { kind: 'unknown-id' }
  // Catch page-listener failures locally: iOS callAsyncJavaScript would otherwise reject native post even though the frame arrived. Report without retrying the same failing listener (ruling 34).
  | { kind: 'inbound-listener-threw'; error: unknown }
  // Claims and presses race; return an unclaimed Back as navigate-back so it still navigates. This diagnostic records the wasted round trip.
  | { kind: 'back-unclaimed' }
