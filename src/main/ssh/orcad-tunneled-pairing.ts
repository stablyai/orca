import { encodePairingOffer, parsePairingCode } from '../../shared/pairing'
import { classifyRemotePairingHostname } from '../../shared/remote-pairing-address'
import type { ServeReadiness } from '../server/serve-readiness'

export function tunneledOrcadPairingCode(readiness: ServeReadiness, localPort: number): string {
  if (!readiness.pairing.available) {
    throw new Error(
      `The managed Orca server did not publish a pairing offer: ${readiness.pairing.guidance}`
    )
  }
  const offer = parsePairingCode(readiness.pairing.url)
  if (!offer) {
    throw new Error('The managed Orca server published an invalid pairing offer.')
  }
  const endpoint = new URL(offer.endpoint)
  if (
    (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') ||
    classifyRemotePairingHostname(endpoint.hostname) !== 'loopback'
  ) {
    throw new Error('The managed Orca server pairing endpoint is not loopback-only.')
  }
  endpoint.hostname = '127.0.0.1'
  endpoint.port = String(localPort)
  return encodePairingOffer({ ...offer, endpoint: endpoint.toString() })
}
