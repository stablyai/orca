import type { ServeReadiness } from '../server/serve-readiness'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { resolveAdvertisedPairingEndpoint } from '../runtime/pairing-endpoint'
import { renderServePairingQr } from '../server/serve-pairing-output'
import type { OrcadHealth } from './orcad-health'
import type { OrcadOptions } from './orcad-entry'

/** The readiness payload orcad publishes once its RPC transport is listening. */
export async function buildOrcadServeReadiness(input: {
  options: OrcadOptions
  runtimeId: string
  rpc: Pick<OrcaRuntimeRpcServer, 'getWebSocketEndpoint' | 'createPairingOffer'>
  collectHealth: () => Promise<OrcadHealth>
}): Promise<ServeReadiness> {
  const { options, rpc } = input
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
    runtimeId: input.runtimeId,
    boundEndpoint,
    advertisedEndpoint: advertised?.ok ? advertised.endpoint : null,
    // Why 'settled': the WSL CLI reconciliation barrier is a desktop-launch concern.
    // orcad never runs it, so there is no pending repair a client could race.
    managedWslCliReconciliation: 'settled',
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
      : offer,
    // Why in the readiness payload: this is the one message a supervisor and a deploy
    // transaction both read, and a green orcad with a dead daemon is exactly the
    // looks-healthy-but-useless state they must not activate.
    health: await input.collectHealth()
  }
}
