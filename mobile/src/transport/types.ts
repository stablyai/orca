import { z } from 'zod'
import {
  PAIRING_CODE_MAX_CHARACTERS,
  PAIRING_DEVICE_TOKEN_MAX_CHARACTERS,
  PAIRING_ENDPOINT_MAX_CHARACTERS,
  PAIRING_INPUT_MAX_CHARACTERS,
  PAIRING_PUBLIC_KEY_MAX_CHARACTERS,
  PairingOfferSchema,
  type PairingOffer
} from '../../../src/shared/mobile-relay-pairing-offer'
import {
  MobileAccessEndpointSchema,
  type MobileAccessEndpoint,
  type MobileRelayHostOverlay
} from './mobile-relay-host-overlay'
import { MobileRelayEndpointSchema } from '../../../src/shared/mobile-relay-credential-contract'

export {
  PAIRING_CODE_MAX_CHARACTERS,
  PAIRING_DEVICE_TOKEN_MAX_CHARACTERS,
  PAIRING_ENDPOINT_MAX_CHARACTERS,
  PAIRING_INPUT_MAX_CHARACTERS,
  PAIRING_PUBLIC_KEY_MAX_CHARACTERS,
  PairingOfferSchema
}
export type { PairingOffer }

export const MOBILE_HOST_ID_MAX_CHARACTERS = 4_096
export const MOBILE_HOST_NAME_MAX_CHARACTERS = 4_096
export const MobileHostIdSchema = z.string().min(1).max(MOBILE_HOST_ID_MAX_CHARACTERS)

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

export type ConnectionLogEntry = {
  id: string
  ts: number
  level: ConnectionLogLevel
  // Short human-readable phase label, e.g. 'Opening WebSocket'.
  message: string
  // Optional second line for endpoint/error/elapsed detail.
  detail?: string
}

export type ConnectionLogSink = (entry: ConnectionLogEntry) => void

export type ConnectionState =
  | 'connecting'
  | 'handshaking'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'auth-failed'

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

export const HostProfileSchema = z.object({
  id: MobileHostIdSchema,
  name: z.string().min(1).max(MOBILE_HOST_NAME_MAX_CHARACTERS),
  endpoint: z.string().min(1).max(PAIRING_ENDPOINT_MAX_CHARACTERS),
  deviceToken: z.string().min(1).max(PAIRING_DEVICE_TOKEN_MAX_CHARACTERS),
  publicKeyB64: z.string().min(1).max(PAIRING_PUBLIC_KEY_MAX_CHARACTERS),
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
  id: MobileHostIdSchema,
  name: z.string().min(1).max(MOBILE_HOST_NAME_MAX_CHARACTERS),
  endpoint: z.string().min(1).max(PAIRING_ENDPOINT_MAX_CHARACTERS),
  publicKeyB64: z.string().min(1).max(PAIRING_PUBLIC_KEY_MAX_CHARACTERS),
  lastConnected: z.number().finite()
})

export type StoredHostProfile = z.infer<typeof StoredHostProfileSchema>
