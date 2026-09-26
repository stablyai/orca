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

/**
 * `_meta` is optional because the wire does not guarantee it. `isRpcResponse`, which is what both
 * sides of the bridge actually read a reply through, checks `id`, `ok` and the presence of
 * `result` or `error` and never looks at `_meta`; `src/shared/runtime-rpc-envelope.ts` already
 * makes it optional on a failure. The shell also answers `native.` verbs itself, and those replies
 * name no runtime because none produced them. Nothing in this app reads the field.
 */
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
  // The relay close code behind a relay-dial-failed entry, so diagnostics need not read it out of `detail`.
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

// Why: a user-attention nudge must not tear down a healthy relay (probe it); only a
// network-change nudge marks the socket suspect enough to replace it.
export type ForegroundNudgeReason = 'focus' | 'app-resume' | 'network-change'

export type HostProfile = {
  id: string
  /** Resolved display value; the store maintains `name === personalName ?? lastKnownMachineName ?? "Host N"`,
   *  except that a desktop reporting its OS without a machine name leaves the last adopted one here. */
  name: string
  /** The name typed on this phone. Present only when the user renamed the host here; it overrides the desktop's. */
  personalName?: string
  /** What the desktop last called itself over status.get, kept for offline and post-restart rows. */
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

// Why: salvaged so a value this build cannot read (a newer build's platform, an empty string)
// drops only that field; a failed record parse would drop the whole paired host on the next write.
// The outer `.optional()` keeps the inferred key optional rather than required `T | undefined`.
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

// Why: persisted host record after the v0.0.3 keychain split. The
// deviceToken is held in iOS Keychain via expo-secure-store and joined
// in at load time; it must NOT appear in AsyncStorage anymore.
export const StoredHostProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  ...hostNameIdentityFields,
  endpoint: z.string().min(1),
  publicKeyB64: z.string().min(1),
  lastConnected: z.number().finite()
})

export type StoredHostProfile = z.infer<typeof StoredHostProfileSchema>
