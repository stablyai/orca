import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { resolveAdvertisedPairingEndpoint } from '../runtime/pairing-endpoint'
import { assertServeProjectRoot, renderServePairingQr } from './serve-pairing-output'
import type { ServeReadiness, ServeReadinessOutput } from './serve-readiness'

type DirectPairingRpc = Pick<OrcaRuntimeRpcServer, 'getWebSocketEndpoint' | 'createPairingOffer'>
type MobileRelayPairingRpc = Pick<OrcaRuntimeRpcServer, 'createMobilePairingOffer'>

/**
 * Endpoint and pairing-offer fields shared by the Electron serve host and orcad.
 * `mobileRelay` is passed only by a host that runs the Relay service (orcad does not).
 */
export async function buildServePairingReadiness(
  options: {
    pairingAddress?: string | null
    noPairing?: boolean
    mobilePairing?: boolean
    grantDesktopControl?: boolean
  },
  rpc: DirectPairingRpc,
  mobileRelay?: MobileRelayPairingRpc
): Promise<Pick<ServeReadiness, 'boundEndpoint' | 'advertisedEndpoint' | 'pairing'>> {
  const boundEndpoint = rpc.getWebSocketEndpoint()
  const advertised = boundEndpoint
    ? resolveAdvertisedPairingEndpoint(boundEndpoint, options.pairingAddress)
    : null
  const name = `${options.mobilePairing ? 'Mobile' : 'CLI'} ${new Date().toLocaleDateString()}`
  const createDirectOffer = (): ReturnType<DirectPairingRpc['createPairingOffer']> =>
    rpc.createPairingOffer({
      address: options.pairingAddress,
      name,
      scope: options.mobilePairing ? 'mobile' : 'runtime',
      grants: options.grantDesktopControl ? ['desktop-control'] : []
    })
  const offer = options.noPairing
    ? ({
        available: false,
        reason: 'disabled_by_operator',
        guidance: 'Restart without --no-pairing to create a client pairing offer.'
      } as const)
    : options.mobilePairing && mobileRelay
      ? await createRelayMobileOffer(mobileRelay, options.pairingAddress, name, createDirectOffer)
      : createDirectOffer()

  return {
    boundEndpoint,
    advertisedEndpoint: advertised?.ok ? advertised.endpoint : null,
    pairing: offer.available
      ? {
          available: true,
          url: offer.pairingUrl,
          endpoint: offer.endpoint,
          deviceId: offer.deviceId,
          webClientUrl: offer.webClientUrl,
          scope: options.mobilePairing ? 'mobile' : 'runtime',
          qr: options.mobilePairing ? await renderServePairingQr(offer.pairingUrl) : null
        }
      : offer
  }
}

async function createRelayMobileOffer(
  mobileRelay: MobileRelayPairingRpc,
  address: string | null | undefined,
  name: string,
  createDirectOffer: () => ReturnType<DirectPairingRpc['createPairingOffer']>
): Promise<
  | Awaited<ReturnType<MobileRelayPairingRpc['createMobilePairingOffer']>>
  | ReturnType<DirectPairingRpc['createPairingOffer']>
> {
  const relayOffer = await mobileRelay.createMobilePairingOffer({
    address,
    connectionMode: 'automatic',
    name
  })
  if (relayOffer.available || relayOffer.reason !== 'relay_mint_failed') {
    return relayOffer
  }
  // Why: a host not signed in to Orca Relay still served a working LAN/Tailscale QR before;
  // keep that rather than leave the operator with no pairing at all.
  console.warn(
    `[serve] Relay pairing unavailable (${relayOffer.relayFailure?.code ?? relayOffer.reason}); ` +
      'printing a LAN-only mobile pairing link instead.'
  )
  return createDirectOffer()
}

export function servePublishMode(options: {
  recipeJson?: boolean
  projectRoot?: string | null
  json?: boolean
}): ServeReadinessOutput {
  return options.recipeJson && options.projectRoot
    ? { mode: 'recipe-json', projectRoot: assertServeProjectRoot(options.projectRoot) }
    : { mode: options.json ? 'json' : 'human' }
}
