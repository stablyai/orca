import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcAnyMethodDeclaration } from '../rpc/core'
import type { DeviceRegistry } from '../device-registry'
import type { E2EEKeypair } from '../e2ee-keypair'
import type { MobileSocketTransportMetadata } from '../rpc/mobile-socket-wiring'
import type { PairingRelay } from '../../../shared/mobile-relay-pairing-offer'
import type { MobilePairingConnectionMode } from '../../../shared/mobile-pairing-connection-mode'
import type { MobileRelayMintFailure } from '../../../shared/mobile-relay-mint-failure'
import type {
  DeviceCredentialInstalled,
  PairingGetEndpointsParams,
  PairingGetEndpointsResult,
  PairingProvisionRelayParams
} from '../../../shared/mobile-relay-credential-contract'
import type {
  RelayDeviceBinding,
  RelayRevokeOutboxItem
} from '../mobile-cloud-relay/relay-revoke-outbox'

export const DEFAULT_WS_PORT = 6768

// Unpaired desktop starts on loopback; explicit network pairing or serve may expose interfaces (STA-2370).
export const WS_BIND_HOST_LOOPBACK = '127.0.0.1'
export const WS_BIND_HOST_ALL_INTERFACES = '0.0.0.0'

// Bracket IPv6 or new URL cannot parse the advertised endpoint.
export function formatWsEndpoint(host: string, port: number): string {
  return `ws://${host.includes(':') ? `[${host}]` : host}:${port}`
}

export type OrcaRuntimeRpcServerOptions = {
  runtime: OrcaRuntimeService
  userDataPath: string
  pid?: number
  platform?: NodeJS.Platform
  enableWebSocket?: boolean
  wsPort?: number
  // Explicit serve pins precede persisted fallback ports (#8535).
  preferPinnedWsPort?: boolean
  // Strict port pins refuse occupied ports instead of silently moving (#26603).
  requirePinnedWsPort?: boolean
  // Only explicit serve opt-in and E2E expose at startup; desktop widens when network pairing requires it (STA-2370).
  exposeNetworkByDefault?: boolean
  /** Explicit address pins govern the whole process: override startup exposure and reconnect defaults, and refuse pairing-time widening. Loopback must survive pairing and restart. */
  pinnedBindHost?: string
  webClientRoot?: string
  // Test-only timing overrides; production keeps design §3.1 defaults.
  keepaliveIntervalMs?: number
  longPollCap?: number
  // Why: test-only override for the ownership reclaim cadence.
  metadataOwnershipPollMs?: number
  // Why: tests may inject inert protocol stages before production authorization registers them.
  methods?: readonly RpcAnyMethodDeclaration[]
}

export type PairingOfferUnavailableReason =
  | 'websocket_unavailable'
  | 'device_registry_unavailable'
  | 'e2ee_key_unavailable'
  | 'invalid_advertised_endpoint'
  | 'relay_mint_failed'
  | 'network_exposure_failed'

export type PairingOfferUnavailable = {
  available: false
  reason: PairingOfferUnavailableReason
  guidance: string
  /** Present when an Anywhere mint refused to silently fall back to LAN-only. */
  relayFailure?: MobileRelayMintFailure
}

export type MobilePairingOfferAvailable = {
  available: true
  pairingUrl: string
  endpoint: string
  deviceId: string
  webClientUrl: string | null
  /** Mode the offer actually encodes. */
  connectionMode: MobilePairingConnectionMode
}

export type MobilePairingOffer = PairingOfferUnavailable | MobilePairingOfferAvailable

export type PairingIdentityInitialization =
  | { ok: true; deviceRegistry: DeviceRegistry; e2eeKeypair: E2EEKeypair }
  | { ok: false; failure: PairingOfferUnavailable }

export function pairingUnavailable(
  reason: PairingOfferUnavailableReason,
  guidance: string
): PairingOfferUnavailable {
  return { available: false, reason, guidance }
}

export const DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE =
  'The pairing registry is unavailable. Verify that the Orca data directory is writable.'
export const E2EE_KEY_UNAVAILABLE_GUIDANCE =
  'The E2EE identity is unavailable. Verify that the Orca data directory is writable.'

export type MobileRelayPairingProvider = {
  createPairingRelay(
    relayDeviceId: string
  ): Promise<{ relay: PairingRelay; binding: RelayDeviceBinding }>
  onDeviceRevokeQueued(item: RelayRevokeOutboxItem): void
  onDemandStateChanged?(): void
  getEndpoints(
    context: MobilePairingConnectionContext,
    params: PairingGetEndpointsParams
  ): Promise<PairingGetEndpointsResult>
  provisionRelay(
    context: MobilePairingConnectionContext,
    params: PairingProvisionRelayParams
  ): Promise<DeviceCredentialInstalled>
}

export type MobilePairingConnectionContext = Readonly<{
  deviceId: string
  connectionId: string
  transport: MobileSocketTransportMetadata
}>

// Keepalive counts as traffic at both ends so long polls survive 30s/60s idle limits (design §3.1).

export function createWebClientUrl(endpoint: string, pairingUrl: string): string {
  const url = new URL(endpoint)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = webClientPathForEndpoint(url.pathname)
  url.search = ''
  // Credential-bearing pairing fragments stay out of proxy logs and Referer headers.
  url.hash = `pairing=${encodeURIComponent(pairingUrl)}`
  return url.toString()
}

export function webClientPathForEndpoint(pathname: string): string {
  if (!pathname || pathname === '/') {
    return '/web-index.html'
  }
  return `${pathname.replace(/\/$/, '')}/web-index.html`
}
