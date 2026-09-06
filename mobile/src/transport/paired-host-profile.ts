import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import type { MobileRelayPairingJournal } from './mobile-relay-pairing-journal'
import type { HostProfile, PairingOffer } from './types'

/** HostProfile for a journal-less pairing (direct ws or iroh path). */
export function baseHost(
  offer: PairingOffer,
  hostId: string,
  name: string,
  lastConnected: number
): HostProfile {
  return {
    id: hostId,
    name,
    endpoint: offer.endpoint,
    deviceToken: offer.deviceToken,
    publicKeyB64: offer.publicKeyB64,
    lastConnected,
    // Why: iroh dial target + hints must survive re-pair → reconnect without re-scanning.
    ...(offer.iroh
      ? {
          iroh: {
            endpointId: offer.iroh.endpointId,
            ...(offer.iroh.relayUrl ? { relayUrl: offer.iroh.relayUrl } : {}),
            ...(offer.iroh.directAddresses?.length
              ? { directAddresses: offer.iroh.directAddresses }
              : {})
          }
        }
      : {})
  }
}

/** HostProfile promoted from a relay pairing journal after credential install. */
export function relayHost(
  journal: MobileRelayPairingJournal,
  relay: MobileRelayEndpoint
): HostProfile {
  const host = journal.metadata.host
  return {
    ...host,
    deviceToken: journal.secrets.deviceToken,
    endpoints: [
      { id: 'direct-primary', kind: 'lan', url: host.endpoint },
      { id: 'relay-primary', kind: 'relay', url: relayWebSocketUrl(relay) }
    ],
    relayHostId: relay.relayHostId,
    relay
  }
}

function relayWebSocketUrl(relay: MobileRelayEndpoint): string {
  const url = new URL(relay.cellUrl)
  url.protocol = 'wss:'
  url.pathname = `/v1/connect/${encodeURIComponent(relay.relayHostId)}`
  return url.toString()
}
