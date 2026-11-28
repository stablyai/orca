export type ConnectionState =
  | 'connecting'
  | 'handshaking'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'auth-failed'

// Attention nudges probe healthy relays; only a network change justifies replacing the socket.
export type ForegroundNudgeReason = 'focus' | 'app-resume' | 'network-change'
