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
