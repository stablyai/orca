import type { connect, ConnectOptions } from './rpc-client'
import type { openIrohRpcClient } from './mobile-iroh-physical-link'
import type { PairingCandidate } from './pairing-candidate-race'
import { attributePairingLogPath } from './pairing-log-path'
import type { PairingOffer } from '../../../src/shared/remote-runtime/pairing/mobile-relay-pairing-offer'

/**
 * Opens the one non-relay pairing candidate. Iroh offers pair over native iroh when available.
 * Only legacy offers with a WebSocket endpoint can fall back to a direct dial.
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
  if (offer.iroh && !args.hasJournal && (args.platform === 'ios' || args.platform === 'android')) {
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
  if (new URL(offer.endpoint).protocol === 'iroh:') {
    throw new Error(
      'Iroh pairing is unsupported by this app build. On the desktop, choose Local network or Relay and scan a new QR code.'
    )
  }
  const directClient = args.connectDirect(offer.endpoint, offer.deviceToken, offer.publicKeyB64, {
    ...connectOptions,
    onLog: attributePairingLogPath('direct', connectOptions?.onLog)
  })
  return { path: 'direct', client: directClient }
}
