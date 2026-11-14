import 'zod'
import '../../../../src/shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import '../../../../src/shared/remote-runtime/relay/mobile-relay-credential-contract'
import './mobile-runtime-host-platform'
import '../../../../src/shared/zod-salvage'
import '../hosts/host-status-reply-schema'

export type ConnectionState =
  | 'connecting'
  | 'handshaking'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'auth-failed'

// Attention nudges probe healthy relays; only a network change justifies replacing the socket.
export type ForegroundNudgeReason = 'focus' | 'app-resume' | 'network-change'
