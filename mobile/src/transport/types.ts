import { z } from 'zod'
import {
  MAX_PAIRING_ENDPOINTS,
  PairingOfferSchema,
  type PairingOffer
} from '../../../src/shared/mobile-relay-pairing-offer'
import {
  MobileAccessEndpointSchema,
  type MobileAccessEndpoint,
  type MobileRelayHostOverlay
} from './mobile-relay-host-overlay'
import { MobileRelayEndpointSchema } from '../../../src/shared/mobile-relay-credential-contract'

export { MAX_PAIRING_ENDPOINTS, PairingOfferSchema }
export type { MobileAccessEndpoint, PairingOffer }

/** Preferred dial order: `endpoints` when present, else `[endpoint]`. Deduped + capped. */
export function normalizePairingEndpoints(
  endpoint: string,
  endpoints?: readonly string[] | null
): string[] {
  const primary = endpoint.trim()
  const raw = endpoints && endpoints.length > 0 ? [...endpoints] : [primary]
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const candidate of [primary, ...raw]) {
    const value = candidate.trim()
    if (!value || seen.has(value)) {
      continue
    }
    seen.add(value)
    ordered.push(value)
    if (ordered.length >= MAX_PAIRING_ENDPOINTS) {
      break
    }
  }
  return ordered.length > 0 ? ordered : [primary]
}

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
  /** Sticky reconnect hint only (KTD9). */
  lastGoodEndpoint?: string
  /** Explicit opt-in to authoritative sequential route ordering. */
  routeOrder?: 1
  endpoints?: MobileAccessEndpoint[]
  relayHostId?: MobileRelayHostOverlay['relayHostId']
  relay?: MobileRelayHostOverlay['relay']
}

export const HostProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  endpoint: z.string().min(1),
  deviceToken: z.string().min(1),
  publicKeyB64: z.string().min(1),
  lastConnected: z.number().finite(),
  lastGoodEndpoint: z.string().min(1).optional(),
  routeOrder: z.literal(1).optional(),
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
  lastGoodEndpoint: z.string().min(1).optional(),
  publicKeyB64: z.string().min(1),
  lastConnected: z.number().finite()
})

export type StoredHostProfile = z.infer<typeof StoredHostProfileSchema>
