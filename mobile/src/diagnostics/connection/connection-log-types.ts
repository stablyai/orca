import 'zod'
import '../../../../src/shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import '../../../../src/shared/remote-runtime/relay/mobile-relay-credential-contract'
import '../../transport/connection/mobile-runtime-host-platform'
import '../../../../src/shared/zod-salvage'
import '../../transport/hosts/host-status-reply-schema'

export type ConnectionLogLevel = 'info' | 'success' | 'warn' | 'error'

export type MobileConnectionDiagnosticPath = 'lan' | 'tailscale' | 'relay'

export type ConnectionDiagnosticCode =
  | 'native-render-failed'
  | 'client-session-started'
  | 'app-resumed'
  | 'network-changed'
  | 'suspended-dial'
  | 'connect-timeout'
  | 'handshake-timeout'
  | 'authentication-rejected'
  | 'socket-closed'
  | 'liveness-timeout'
  | 'retry-scheduled'
  | 'relay-dial-failed'
  | 'relay-session-failed'
  | 'relay-connected'
  | 'direct-connected'
  | 'relay-credential-unavailable'
  | 'host-open-failed'
  // OTA web shell lifecycle; diagnostics only, never read as connection failures.
  | 'web-shell-flow'
  | 'web-shell-page'
  | 'web-shell-stalled'
  | 'web-shell-bridge'

export type ConnectionLogEntry = {
  id: string
  ts: number
  level: ConnectionLogLevel
  message: string
  detail?: string
  code?: ConnectionDiagnosticCode
  path?: MobileConnectionDiagnosticPath
  // Carry the relay close code separately so diagnostics need not parse detail.
  relayCloseCode?: number
}

export type ConnectionLogSink = (entry: ConnectionLogEntry) => void

export type ConnectionLogEmitter = (
  level: ConnectionLogLevel,
  message: string,
  detail?: string,
  evidence?: Pick<ConnectionLogEntry, 'code' | 'path'>
) => void
