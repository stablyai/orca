import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcAnyMethod } from '../rpc/core'
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
import type { RelayDeviceBinding, RelayRevokeOutboxItem } from '../relay/relay-revoke-outbox'

export const DEFAULT_WS_PORT = 6768

// Why: STA-2370 — the WS listener defaults to loopback so a desktop with no paired device is not
// reachable from the LAN; it widens to all interfaces only on explicit pairing (or `orca serve`).
export const WS_BIND_HOST_LOOPBACK = '127.0.0.1'
export const WS_BIND_HOST_ALL_INTERFACES = '0.0.0.0'

// Why brackets: `ws://::1:6768` is not a URL, and every consumer of this endpoint parses it
// with `new URL`. An IPv6 bind address would otherwise publish an unparseable endpoint.
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
  // Why: true when the caller pinned a port (`orca serve --port`) so bind order prefers it over a stale STA-1511 fallback (#8535).
  preferPinnedWsPort?: boolean
  // Why: STA-2370 — bind the WS listener to all interfaces at startup instead of loopback-until-paired.
  // Only `orca serve` (explicit remote opt-in) and E2E set this; the desktop app widens lazily on pairing.
  exposeNetworkByDefault?: boolean
  /**
   * Pin the WS listener to exactly this address for the process's whole life.
   *
   * Why a pin and not another default: the two paths below both widen on their own —
   * `exposeNetworkByDefault` at startup, and a device that has connected once at every
   * later startup. An unattended host (orcad) whose operator asked for loopback must
   * still be on loopback after a client pairs and the service restarts, so the answer
   * has to outrank both, and `ensureNetworkExposure()` has to refuse rather than widen.
   */
  pinnedBindHost?: string
  webClientRoot?: string
  // Why: test-only overrides for the two constants below; production must not pass these (defaults set by §3.1).
  keepaliveIntervalMs?: number
  longPollCap?: number
  // Why: test-only override for the ownership reclaim cadence.
  metadataOwnershipPollMs?: number
  // Why: tests may inject inert protocol stages before production authorization registers them.
  methods?: readonly RpcAnyMethod[]
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

// Why: keepalive frames count as socket activity, resetting both idle timers so long-polls outlive the 30s/60s idle caps. See §3.1.

export function createWebClientUrl(endpoint: string, pairingUrl: string): string {
  const url = new URL(endpoint)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = webClientPathForEndpoint(url.pathname)
  url.search = ''
  // Why: pairing URLs carry full credentials; the fragment keeps them out of proxy logs and Referer headers.
  url.hash = `pairing=${encodeURIComponent(pairingUrl)}`
  return url.toString()
}

export function webClientPathForEndpoint(pathname: string): string {
  if (!pathname || pathname === '/') {
    return '/web-index.html'
  }
  return `${pathname.replace(/\/$/, '')}/web-index.html`
}
