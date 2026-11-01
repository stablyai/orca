/** Pairing offers requested by this host's owner: the desktop's Settings and `orca pair` mint the same offers. */
import type { MobilePairingConnectionMode } from '../../shared/mobile-pairing-connection-mode'
import type {
  PairingCreateOfferParams,
  PairingCreateOfferResult
} from '../../shared/pairing-create-offer-contract'
import { classifyRemotePairingHostname } from '../../shared/remote-pairing-address'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import { renderServePairingQr } from '../server/serve-pairing-output'
import { NETWORK_EXPOSURE_FAILED_GUIDANCE } from './network-exposure-guidance'
import { resolveAdvertisedPairingHostname } from './pairing-endpoint'
import {
  getDefaultPairingAddress,
  type DefaultRouteInterfaceLookup
} from './pairing-network-interfaces'
import type { RuntimeDeviceGrant } from './rpc/rpc-method-permission'
import type { RuntimeRpcPairing } from './runtime-rpc/runtime-rpc-pairing'
import {
  pairingUnavailable,
  type MobilePairingOffer,
  type MobilePairingOfferAvailable,
  type PairingOfferUnavailable
} from './runtime-rpc/runtime-rpc-pairing-types'
import { getWindowsDefaultRouteInterfaceNames } from './windows-default-route-interfaces'

export type PairingOfferServer = Pick<
  RuntimeRpcPairing,
  'getNetworkExposureBindHost' | 'ensureNetworkExposure' | 'createPairingOffer'
> & {
  createMobilePairingOffer(args: {
    address?: string | null
    connectionMode?: MobilePairingConnectionMode
    name?: string
    rotate?: boolean
  }): Promise<MobilePairingOffer>
}

const NO_PAIRING_ADDRESS_GUIDANCE =
  'No reachable network address is available for pairing. Connect to Wi‑Fi or Tailscale, or pick an address manually.'

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
  args: { address?: string; connectionMode?: MobilePairingConnectionMode; rotate?: boolean },
  lookup: DefaultRouteInterfaceLookup = getWindowsDefaultRouteInterfaceNames
): Promise<
  | PairingOfferUnavailable
  | (Omit<MobilePairingOfferAvailable, 'endpoint'> & { endpoint: string | null })
> {
  const ip = await pairingAddress(server, args.address, lookup)
  // Relay works without a direct candidate; LAN-only must refuse when none is usable.
  if (!ip && args.connectionMode === 'local-only') {
    return pairingUnavailable('invalid_advertised_endpoint', NO_PAIRING_ADDRESS_GUIDANCE)
  }
  // Reuse never-scanned tokens until explicit rotation; authenticated entries remain independent.
  const offer = await server.createMobilePairingOffer({
    address: ip,
    connectionMode: args.connectionMode,
    rotate: args.rotate,
    name: `Mobile ${new Date().toLocaleDateString()}`
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
  },
  lookup: DefaultRouteInterfaceLookup = getWindowsDefaultRouteInterfaceNames
): Promise<ReturnType<PairingOfferServer['createPairingOffer']>> {
  const ip = await pairingAddress(server, args.address, lookup)
  if (!ip) {
    return pairingUnavailable('invalid_advertised_endpoint', NO_PAIRING_ADDRESS_GUIDANCE)
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
    grants: args.grants
  })
}

export async function createOwnerPairingOffer(
  server: PairingOfferServer,
  params: PairingCreateOfferParams,
  lookup?: DefaultRouteInterfaceLookup
): Promise<PairingCreateOfferResult> {
  if (params.scope === 'mobile') {
    const offer = await requestMobilePairingOffer(
      server,
      {
        address: params.address,
        // A headless host has no Relay; Relay stays an explicit opt-in here as on the desktop.
        connectionMode: params.relay ? 'automatic' : 'local-only',
        rotate: params.rotate
      },
      lookup
    )
    if (!offer.available) {
      return { available: false, reason: offer.reason, guidance: offer.guidance }
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
      grants: params.grantDesktopControl ? ['desktop-control'] : []
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
