import type { BrowserScreencastFrame } from './browser-screencast-protocol'
import type { RpcEnvelopeFields } from './rpc-envelope-fields'
import type { UnvalidatedRpcRequestPort } from './unvalidated-rpc-request-port'
import { z } from 'zod'
import {
  PairingOfferSchema,
  type PairingOffer
} from '../../../src/shared/mobile-relay-pairing-offer'
import {
  MobileRelayEndpointSchema,
  type MobileRelayEndpoint
} from '../../../src/shared/mobile-relay-credential-contract'
import { NODE_PLATFORM_NAMES } from './mobile-runtime-host-platform'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

export { PairingOfferSchema }
export type { PairingOffer }

export type RpcRequest = {
  id: string
  deviceToken: string
  method: string
  params?: unknown
}

// Wire validation does not require _meta, and shell-produced native replies have no runtime to name.
export type RpcSuccess = {
  id: string
  ok: true
  result: unknown
  streaming?: true
  _meta?: { runtimeId: string }
}

export type RpcFailure = {
  id: string
  ok: false
  error: { code: string; message: string; data?: unknown }
  _meta?: { runtimeId: string }
}

export type RpcResponse = RpcSuccess | RpcFailure

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

export type ConnectionState =
  | 'connecting'
  | 'handshaking'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'auth-failed'

// Attention nudges probe healthy relays; only a network change justifies replacing the socket.
export type ForegroundNudgeReason = 'focus' | 'app-resume' | 'network-change'

export type HostProfile = {
  id: string
  // Resolved display name; an OS-only desktop report preserves the last adopted name.
  name: string
  // This phone’s rename overrides the desktop’s machine name.
  personalName?: string
  // Last desktop-reported name, retained offline and across restarts.
  lastKnownMachineName?: string
  lastKnownHostPlatform?: NodeJS.Platform
  endpoint: string
  deviceToken: string
  publicKeyB64: string
  lastConnected: number
  /** Relay routing, joined from the overlay; only `setRelayRouting` and pairing write it. */
  relay?: MobileRelayEndpoint
}

export type HostCredentialStatus = 'ready' | 'temporarily-unavailable' | 'missing'

export type HostCatalogEntry = Omit<HostProfile, 'deviceToken'> & {
  credentialStatus: HostCredentialStatus
  profile: HostProfile | null
}

// Salvage unknown/empty platform values independently so persisting them cannot drop the paired host.
// Keep outer optional() so the inferred key remains optional.
const hostNameIdentityFields = {
  personalName: salvagedOptional('personalName', z.string().min(1)).optional(),
  lastKnownMachineName: salvagedOptional('lastKnownMachineName', z.string().min(1)).optional(),
  lastKnownHostPlatform: salvagedOptional(
    'lastKnownHostPlatform',
    z.enum(NODE_PLATFORM_NAMES)
  ).optional()
}

export const HostProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  ...hostNameIdentityFields,
  endpoint: z.string().min(1),
  deviceToken: z.string().min(1),
  publicKeyB64: z.string().min(1),
  lastConnected: z.number().finite(),
  relay: MobileRelayEndpointSchema.optional()
})

// Never persist deviceToken in AsyncStorage; join it from Keychain when loading the host.
export const StoredHostProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  ...hostNameIdentityFields,
  endpoint: z.string().min(1),
  publicKeyB64: z.string().min(1),
  lastConnected: z.number().finite()
})

export type StoredHostProfile = z.infer<typeof StoredHostProfileSchema>

type SubscribeOptions = {
  onBinaryFrame?: (frame: BrowserScreencastFrame) => void
  // Repeat these top-level fields on subscription replay and unsubscribe.
  envelope?: RpcEnvelopeFields
}

type StreamingListener = (result: unknown) => void

// Holding a client also exposes the raw port, so the boundary inventory must cover client holders.
export type RpcClient = UnvalidatedRpcRequestPort & {
  subscribe: (
    method: string,
    params: unknown,
    onData: StreamingListener,
    options?: SubscribeOptions
  ) => () => void
  updateTerminalSubscriptionViewport: (
    terminal: string,
    viewport: { cols: number; rows: number }
  ) => void
  getState: () => ConnectionState
  getReconnectAttempt: () => number
  getLastConnectedAt: () => number | null
  getLastInboundAt?: () => number | null
  // Optional logical authority epoch for scoping cached work across migrateTo; physical clients need no counter.
  getGeneration?: () => number
  /** False when this transport would refuse an `envelope`; absent means it carries one. */
  carriesRpcEnvelope?: () => boolean
  onStateChange: (listener: (state: ConnectionState) => void) => () => void
  notifyForeground: (reason?: ForegroundNudgeReason) => void
  // A caller that stopped hearing back asks for one decisive probe, so a silently dead socket ends in seconds.
  probeLivenessNow?: () => void
  // Settle every pending request before returning; only the physical sender knows which reached the wire.
  // Reject written requests with markRpcDeliveryUnknown: the host may already have executed them.
  close: () => void
}
