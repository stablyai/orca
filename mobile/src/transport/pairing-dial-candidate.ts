import type { connect, ConnectOptions } from './rpc-client'
import type { openIrohRpcClient } from './mobile-iroh-physical-link'
import type { PairingCandidate } from './pairing-candidate-race'
import { isWebSocketEndpoint } from './host-endpoint'
import { attributePairingLogPath } from './pairing-log-path'
import type { PairingOffer } from './types'

export const IROH_PAIRING_UNSUPPORTED_MESSAGE =
  'This app build cannot use Iroh. On the computer, choose LAN or Orca Relay and scan the new code.'

/**
 * Opens the one non-relay pairing candidate. Iroh offers pair over iroh itself — it reaches the
 * desktop on LAN and cellular alike — so the ws dial and its failure noise are skipped unless
 * iroh is unavailable here (web / Expo Go / a build without the native module) or a relay
 * journal implies direct/relay.
 */
export function openPairingDialCandidate(args: {
  offer: PairingOffer
  hasJournal: boolean
  connectDirect: typeof connect
  connectIroh: typeof openIrohRpcClient
  connectOptions?: ConnectOptions
}): PairingCandidate {
  const { offer, connectOptions } = args
  if (offer.iroh && !args.hasJournal) {
    const onLog = attributePairingLogPath('iroh', connectOptions?.onLog)
    const { relayUrl, directAddresses } = offer.iroh
    const irohClient = args.connectIroh({
      desktopEndpointId: offer.iroh.endpointId,
      ...(relayUrl || directAddresses?.length
        ? {
            dialHints: {
              ...(relayUrl ? { relayUrl } : {}),
              ...(directAddresses?.length ? { directAddresses } : {})
            }
          }
        : {}),
      deviceToken: offer.deviceToken,
      publicKeyB64: offer.publicKeyB64,
      ...(onLog ? { onLog } : {})
    })
    if (irohClient) {
      return { path: 'iroh', client: irohClient }
    }
  }
  // An iroh-only offer has no WebSocket endpoint to fall back to.
  if (!isWebSocketEndpoint(offer.endpoint)) {
    throw new Error(IROH_PAIRING_UNSUPPORTED_MESSAGE)
  }
  const directClient = args.connectDirect(offer.endpoint, offer.deviceToken, offer.publicKeyB64, {
    ...connectOptions,
    onLog: attributePairingLogPath('direct', connectOptions?.onLog)
  })
  return { path: 'direct', client: directClient }
}
