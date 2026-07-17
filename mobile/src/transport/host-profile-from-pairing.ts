import { normalizePairingEndpoints, type PairingOffer } from './types'
import type { HostProfile } from './types'
import { buildMobileAccessRoutes } from './mobile-access-route-order'
import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import type { MobileRelayPairingJournal } from './mobile-relay-pairing-journal'

/** Build a host profile from a successful pairing offer (no last-good yet). */
export function hostProfileFromPairingOffer(args: {
  id: string
  name: string
  offer: PairingOffer
  lastConnected?: number
  lastGoodEndpoint?: string
}): HostProfile {
  const urls = normalizePairingEndpoints(args.offer.endpoint, args.offer.endpoints)
  const endpoints = buildMobileAccessRoutes({
    directUrls: urls,
    relayPreferenceIndex: args.offer.relayPreferenceIndex
  })
  return {
    id: args.id,
    name: args.name,
    endpoint: urls[0]!,
    endpoints,
    deviceToken: args.offer.deviceToken,
    publicKeyB64: args.offer.publicKeyB64,
    lastConnected: args.lastConnected ?? Date.now(),
    ...(args.lastGoodEndpoint ? { lastGoodEndpoint: args.lastGoodEndpoint } : {})
  }
}

export function relayHostProfileFromPairing(
  journal: MobileRelayPairingJournal,
  relay: MobileRelayEndpoint,
  lastGoodEndpoint?: string
): HostProfile {
  const host = journal.metadata.host
  return {
    ...host,
    deviceToken: journal.secrets.deviceToken,
    endpoints: buildMobileAccessRoutes({
      directUrls: normalizePairingEndpoints(host.endpoint, host.endpoints),
      relay,
      relayPreferenceIndex: host.relayPreferenceIndex
    }),
    relayHostId: relay.relayHostId,
    relay,
    ...(lastGoodEndpoint ? { lastGoodEndpoint } : {})
  }
}
