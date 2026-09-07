import { z } from 'zod'
import {
  PairingOfferSchema,
  type PairingOffer
} from '../../../src/shared/mobile-relay-pairing-offer'
import {
  MobileAccessEndpointSchema,
  type MobileAccessEndpoint,
  type MobileRelayHostOverlay
} from './mobile-relay-host-overlay'
import { MobileRelayEndpointSchema } from '../../../src/shared/mobile-relay-credential-contract'

export { PairingOfferSchema }
export type { PairingOffer }

export type RpcRequest = {
  id: string
  deviceToken: string
  method: string
  params?: unknown
}

export type RpcSuccess = {
  id: string
  ok: true
  result: unknown
  streaming?: true
  _meta: { runtimeId: string }
}

export type RpcFailure = {
  id: string
  ok: false
  error: { code: string; message: string; data?: unknown }
  _meta: { runtimeId: string }
}

export type RpcResponse = RpcSuccess | RpcFailure

export type ConnectionLogLevel = 'info' | 'success' | 'warn' | 'error'

export type MobileConnectionDiagnosticPath = 'lan' | 'tailscale' | 'relay'

export type ConnectionDiagnosticCode =
  | 'client-session-started'
  | 'app-resumed'
  | 'network-changed'
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

// Why: a 10s connect used to read as one opaque "connecting" span. Attaching the
// duration of the phase an entry closes out lets the report say where the time
// went. Diagnostics only — nothing schedules from these.
export type ConnectionLogTiming = {
  kind: 'relay-dial-stage' | 'connection-state'
  name: string
  ms: number
  // False when the phase never finished (the dial died inside it).
  complete: boolean
}

export type ConnectionLogEntry = {
  id: string
  ts: number
  level: ConnectionLogLevel
  // Short human-readable phase label, e.g. 'Opening WebSocket'.
  message: string
  // Optional second line for endpoint/error/elapsed detail.
  detail?: string
  code?: ConnectionDiagnosticCode
  path?: MobileConnectionDiagnosticPath
  timing?: ConnectionLogTiming
}

export type ConnectionLogSink = (entry: ConnectionLogEntry) => void

export type ConnectionLogEmitter = (
  level: ConnectionLogLevel,
  message: string,
  detail?: string,
  evidence?: Pick<ConnectionLogEntry, 'code' | 'path' | 'timing'>
) => void

export type ConnectionState =
  | 'connecting'
  | 'handshaking'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'auth-failed'

// Exhaustive by construction; see RELAY_DIAL_STAGE_NAMES for why.
export const CONNECTION_STATE_NAMES: Record<ConnectionState, true> = {
  connecting: true,
  handshaking: true,
  connected: true,
  disconnected: true,
  reconnecting: true,
  'auth-failed': true
}

// Why: a user-attention nudge must not tear down a healthy relay (probe it); only a
// network-change nudge marks the socket suspect enough to replace it.
export type ForegroundNudgeReason = 'focus' | 'app-resume' | 'network-change'

export type HostProfile = {
  id: string
  name: string
  endpoint: string
  deviceToken: string
  publicKeyB64: string
  lastConnected: number
  endpoints?: MobileAccessEndpoint[]
  relayHostId?: MobileRelayHostOverlay['relayHostId']
  relay?: MobileRelayHostOverlay['relay']
}

export type HostCredentialStatus = 'ready' | 'temporarily-unavailable' | 'missing'

export type HostCatalogEntry = Omit<HostProfile, 'deviceToken'> & {
  credentialStatus: HostCredentialStatus
  profile: HostProfile | null
}

export const HostProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  endpoint: z.string().min(1),
  deviceToken: z.string().min(1),
  publicKeyB64: z.string().min(1),
  lastConnected: z.number().finite(),
  endpoints: z.array(MobileAccessEndpointSchema).min(1).max(16).optional(),
  relayHostId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16}$/)
    .optional(),
  relay: MobileRelayEndpointSchema.optional()
})

// Why: persisted host record after the v0.0.3 keychain split. The
// deviceToken is held in iOS Keychain via expo-secure-store and joined
// in at load time; it must NOT appear in AsyncStorage anymore.
export const StoredHostProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  endpoint: z.string().min(1),
  publicKeyB64: z.string().min(1),
  lastConnected: z.number().finite()
})

export type StoredHostProfile = z.infer<typeof StoredHostProfileSchema>
