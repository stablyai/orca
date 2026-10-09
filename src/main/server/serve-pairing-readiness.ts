import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { resolveAdvertisedPairingEndpoint } from '../runtime/pairing-endpoint'
import { assertServeProjectRoot, renderServePairingQr } from './serve-pairing-output'
import type { ServeReadiness, ServeReadinessOutput } from './serve-readiness'

/** Endpoint and pairing-offer fields shared by the Electron serve host and orcad. */
export async function buildServePairingReadiness(
  options: {
    pairingAddress?: string | null
    noPairing?: boolean
    mobilePairing?: boolean
    grantDesktopControl?: boolean
  },
  rpc: Pick<OrcaRuntimeRpcServer, 'getWebSocketEndpoint' | 'createPairingOffer'>
): Promise<Pick<ServeReadiness, 'boundEndpoint' | 'advertisedEndpoint' | 'pairing'>> {
  const boundEndpoint = rpc.getWebSocketEndpoint()
  const advertised = boundEndpoint
    ? resolveAdvertisedPairingEndpoint(boundEndpoint, options.pairingAddress)
    : null
  const offer = options.noPairing
    ? ({
        available: false,
        reason: 'disabled_by_operator',
        guidance: 'Restart without --no-pairing to create a client pairing offer.'
      } as const)
    : rpc.createPairingOffer({
        address: options.pairingAddress,
        name: `${options.mobilePairing ? 'Mobile' : 'CLI'} ${new Date().toLocaleDateString()}`,
        scope: options.mobilePairing ? 'mobile' : 'runtime',
        grants: options.grantDesktopControl ? ['desktop-control'] : []
      })

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

export function servePublishMode(options: {
  recipeJson?: boolean
  projectRoot?: string | null
  json?: boolean
}): ServeReadinessOutput {
  return options.recipeJson && options.projectRoot
    ? { mode: 'recipe-json', projectRoot: assertServeProjectRoot(options.projectRoot) }
    : { mode: options.json ? 'json' : 'human' }
}
