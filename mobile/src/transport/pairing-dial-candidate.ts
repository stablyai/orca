import type { connect, ConnectOptions } from './rpc-client'
import type { openIrohRpcClient } from './mobile-iroh-physical-link'
import type { PairingCandidate } from './pairing-candidate-race'
import { attributePairingLogPath } from './pairing-log-path'
import type { PairingOffer } from './types'

/**
 * Opens the one non-relay pairing candidate. Iroh offers pair over iroh itself — it reaches the
 * desktop on LAN and cellular alike — so the ws dial and its failure noise are skipped unless
 * iroh is unavailable here (Android stub / Expo Go) or a relay journal implies direct/relay.
 */
export function openPairingDialCandidate(args: {
  offer: PairingOffer
  hasJournal: boolean
  platform: string
  connectDirect: typeof connect
  connectIroh: typeof openIrohRpcClient
  connectOptions?: ConnectOptions
}): PairingCandidate {
  const { offer, connectOptions } = args
  if (offer.iroh && !args.hasJournal && args.platform === 'ios') {
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
  const directClient = args.connectDirect(offer.endpoint, offer.deviceToken, offer.publicKeyB64, {
    ...connectOptions,
    onLog: attributePairingLogPath('direct', connectOptions?.onLog)
  })
  return { path: 'direct', client: directClient }
}
