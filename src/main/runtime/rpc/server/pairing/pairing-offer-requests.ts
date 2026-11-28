/** Pairing offers requested by this host's owner: the desktop's Settings and `orca pair` mint the same offers. */
import type { MobilePairingConnectionMode } from '../../../../../shared/remote-runtime/pairing/mobile-pairing-connection-mode'
import type { MobileRelayMintFailure } from '../../../../../shared/remote-runtime/relay/mobile-relay-mint-failure'
import type {
  PairingCreateOfferParams,
  PairingCreateOfferResult
} from '../../../../../shared/remote-runtime/pairing/pairing-create-offer-contract'
import { classifyRemotePairingHostname } from '../../../../../shared/remote-runtime/pairing/remote-pairing-address'
import type { RuntimePairingReach } from '../../../../../shared/remote-runtime/pairing/runtime-pairing-reach'
import { renderServePairingQr } from '../../../../server/serve-pairing-output'
import { NETWORK_EXPOSURE_FAILED_GUIDANCE } from './network/network-exposure-guidance'
import { resolveAdvertisedPairingHostname } from './network/pairing-endpoint'
import {
  getDefaultPairingAddress,
  pinnedListenerAddress,
  type DefaultRouteInterfaceLookup
} from './network/pairing-network-interfaces'
import type { RuntimeDeviceGrant } from '../../callers/rpc-method-permission'
import type { RuntimeRpcPairing } from '../runtime-rpc-pairing'
import {
  pairingUnavailable,
  type MobilePairingOffer,
  type MobilePairingOfferAvailable,
  type PairingOfferUnavailable
} from '../runtime-rpc-pairing-types'
import { getWindowsDefaultRouteInterfaceNames } from './network/windows-default-route-interfaces'

export type PairingOfferServer = Pick<
  RuntimeRpcPairing,
  'getNetworkExposureBindHost' | 'ensureNetworkExposure' | 'createPairingOffer'
> & {
  createMobilePairingOffer(args: {
    address?: string | null
    connectionMode?: MobilePairingConnectionMode
    name?: string
    rotate?: boolean
    offerTtlMs?: number
    createdByDeviceId?: string
    reach?: RuntimePairingReach
    exposure?: 'widen' | 'as-bound'
  }): Promise<MobilePairingOffer>
  getBoundWebSocketHost(): string | null
}

const NO_PAIRING_ADDRESS_GUIDANCE =
  'No reachable network address is available for pairing. Connect to Wi‑Fi or Tailscale, or pick an address manually.'

const LOOPBACK_PINNED_GUIDANCE =
  'This Orca listens only on loopback, so nothing can dial it directly. Give an address that forwards to it, such as a tunnel or SSH port-forward.'

function isLoopbackPinned(server: PairingOfferServer): boolean {
  return pinnedListenerAddress(server.getNetworkExposureBindHost()) === null
}

function noPairingAddress(
  server: PairingOfferServer,
  scope: 'mobile' | 'runtime'
): PairingOfferUnavailable {
  if (!isLoopbackPinned(server)) {
    return pairingUnavailable('invalid_advertised_endpoint', NO_PAIRING_ADDRESS_GUIDANCE)
  }
  return pairingUnavailable(
    'invalid_advertised_endpoint',
    scope === 'mobile'
      ? `${LOOPBACK_PINNED_GUIDANCE} Or pair the phone through Orca Relay.`
      : LOOPBACK_PINNED_GUIDANCE
  )
}

// Only explicit this-computer intent plus a loopback address avoids widening; custom tunnel endpoints still need remote reach.
function servesThisComputerOnly(reach: RuntimePairingReach | undefined, address: string): boolean {
  if (reach !== 'this-computer') {
    return false
  }
  const hostname = resolveAdvertisedPairingHostname(address)
  return hostname !== null && classifyRemotePairingHostname(hostname) === 'loopback'
}

async function pairingAddress(
  server: PairingOfferServer,
  address: string | undefined,
  lookup: DefaultRouteInterfaceLookup
): Promise<string | null> {
  // Explicit interfaces support overlay networks unreachable through the default LAN candidate.
  return address ?? (await getDefaultPairingAddress(server.getNetworkExposureBindHost(), lookup))
}

export async function requestMobilePairingOffer(
  server: PairingOfferServer,
  args: {
    address?: string
    connectionMode?: MobilePairingConnectionMode
    rotate?: boolean
    // Unset leaves the offer without an expiry, as headless serve/orcad mint today.
    offerTtlMs?: number
    createdByDeviceId?: string
  },
  lookup: DefaultRouteInterfaceLookup = getWindowsDefaultRouteInterfaceNames
): Promise<
  | PairingOfferUnavailable
  | (Omit<MobilePairingOfferAvailable, 'endpoint'> & { endpoint: string | null })
> {
  const ip = await pairingAddress(server, args.address, lookup)
  // Relay works without a direct candidate; LAN-only must refuse when none is usable.
  if (!ip && args.connectionMode === 'local-only') {
    return noPairingAddress(server, 'mobile')
  }
  // Reuse never-scanned tokens until explicit rotation; authenticated entries remain independent.
  const offer = await server.createMobilePairingOffer({
    address: ip,
    connectionMode: args.connectionMode,
    rotate: args.rotate,
    name: `Mobile ${new Date().toLocaleDateString()}`,
    offerTtlMs: args.offerTtlMs,
    createdByDeviceId: args.createdByDeviceId
  })
  if (!offer.available) {
    return offer
  }
  // Unadvertised loopback fallback points at the scanning device; omit it from UI endpoints.
  return { ...offer, endpoint: ip ? offer.endpoint : null }
}

export async function requestRuntimePairingOffer(
  server: PairingOfferServer,
  args: {
    address?: string
    rotate?: boolean
    reach?: RuntimePairingReach
    grants?: readonly RuntimeDeviceGrant[]
    offerTtlMs?: number
    createdByDeviceId?: string
  },
  lookup: DefaultRouteInterfaceLookup = getWindowsDefaultRouteInterfaceNames
): Promise<ReturnType<PairingOfferServer['createPairingOffer']>> {
  const ip = await pairingAddress(server, args.address, lookup)
  if (!ip) {
    return noPairingAddress(server, 'runtime')
  }
  // Widen before advertising remote reach; this-computer intent must not trigger the irreversible widening (STA-2370).
  const thisComputerOnly = servesThisComputerOnly(args.reach, ip)
  if (!thisComputerOnly) {
    try {
      await server.ensureNetworkExposure()
    } catch (error) {
      console.error(
        '[mobile] Network exposure failed while creating a runtime pairing offer:',
        error
      )
      return pairingUnavailable('network_exposure_failed', NETWORK_EXPOSURE_FAILED_GUIDANCE)
    }
  }
  // Web/desktop runtime clients need full access instead of the phone allow-list.
  return server.createPairingOffer({
    address: ip,
    rotate: args.rotate,
    name: `Runtime ${new Date().toLocaleDateString()}`,
    scope: 'runtime',
    // Persist local reach so local authentication cannot expose the next launch to the LAN.
    reach: thisComputerOnly ? 'this-computer' : 'network',
    grants: args.grants,
    offerTtlMs: args.offerTtlMs,
    createdByDeviceId: args.createdByDeviceId
  })
}

// The terminal has no Relay notice: name the fix, and never suggest LAN to a loopback-only host.
function ownerRelayGuidance(
  failure: MobileRelayMintFailure | undefined,
  loopbackPinned: boolean
): string | null {
  if (!failure) {
    return null
  }
  if (failure.code === 'relay_signed_out') {
    return 'Orca Relay needs this host signed in to Orca. Run `orca auth login` here, then retry.'
  }
  if (failure.code === 'relay_not_entitled') {
    return 'Orca Relay isn’t included with the Orca account this host is signed in to.'
  }
  if (failure.stage === 'provider_missing') {
    return 'Orca Relay isn’t running on this host yet. Retry in a moment; `orca auth status` shows whether this host is signed in.'
  }
  return loopbackPinned ? 'Orca Relay could not create a pairing invite. Retry.' : null
}

export async function createOwnerPairingOffer(
  server: PairingOfferServer,
  params: PairingCreateOfferParams,
  lookup?: DefaultRouteInterfaceLookup,
  createdByDeviceId?: string
): Promise<PairingCreateOfferResult> {
  if (params.scope === 'mobile') {
    const offer = await requestMobilePairingOffer(
      server,
      {
        address: params.address,
        // Relay stays an explicit opt-in here, as on the desktop.
        connectionMode: params.relay ? 'automatic' : 'local-only',
        rotate: params.rotate,
        createdByDeviceId
      },
      lookup
    )
    if (!offer.available) {
      return {
        available: false,
        reason: offer.reason,
        guidance: ownerRelayGuidance(offer.relayFailure, isLoopbackPinned(server)) ?? offer.guidance
      }
    }
    return {
      available: true,
      scope: 'mobile',
      pairingUrl: offer.pairingUrl,
      endpoint: offer.endpoint,
      deviceId: offer.deviceId,
      webClientUrl: offer.webClientUrl,
      connectionMode: offer.connectionMode,
      qr: await renderServePairingQr(offer.pairingUrl)
    }
  }
  const offer = await requestRuntimePairingOffer(
    server,
    {
      address: params.address,
      rotate: params.rotate,
      grants: params.grantDesktopControl ? ['desktop-control'] : [],
      createdByDeviceId
    },
    lookup
  )
  if (!offer.available) {
    return { available: false, reason: offer.reason, guidance: offer.guidance }
  }
  return {
    available: true,
    scope: 'runtime',
    pairingUrl: offer.pairingUrl,
    endpoint: offer.endpoint,
    deviceId: offer.deviceId,
    webClientUrl: offer.webClientUrl,
    connectionMode: null,
    qr: null
  }
}
