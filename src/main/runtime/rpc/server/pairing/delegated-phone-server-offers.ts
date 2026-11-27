/** A phone a paired desktop relays here asks for a pairing of its own, so it keeps reaching this
 *  server while that desktop sleeps. The offer is chained to the phone's delegated row: unpairing
 *  the phone on the desktop, or revoking the desktop here, revokes it too. */
import type {
  DelegatedPhoneServerOfferParams,
  DelegatedPhoneServerOfferResult
} from '../../../../../shared/remote-runtime/pairing/delegated-phone-server-offer-contract'
import type { MobilePairingOffer, PairingOfferUnavailable } from '../runtime-rpc-pairing-types'
import type { DeviceEntry } from './device-entry'
import {
  getDefaultPairingAddress,
  pinnedListenerAddress,
  type DefaultRouteInterfaceLookup
} from './network/pairing-network-interfaces'
import type { PairingOfferServer } from './pairing-offer-requests'

// The phone confirms it right away; a leaked offer stops working soon after.
const DELEGATED_OFFER_TTL_MS = 10 * 60 * 1000

const NO_ROUTE_GUIDANCE =
  'Sign this server in to Orca so your phone can reach it through Orca Relay while your computer sleeps.'

export async function createDelegatedPhoneServerOffer(
  server: Pick<PairingOfferServer, 'createMobilePairingOffer' | 'getBoundWebSocketHost'>,
  caller: DeviceEntry,
  params: DelegatedPhoneServerOfferParams,
  lookup?: DefaultRouteInterfaceLookup
): Promise<DelegatedPhoneServerOfferResult> {
  // STA-2370: never widen for a phone. A direct route only when the listener already answers off this host.
  const bound = server.getBoundWebSocketHost()
  const address =
    bound !== null && pinnedListenerAddress(bound) !== null
      ? await getDefaultPairingAddress(bound, lookup)
      : null
  const offer = {
    address,
    name: caller.name,
    offerTtlMs: DELEGATED_OFFER_TTL_MS,
    createdByDeviceId: caller.deviceId,
    // The caller's reach, so this pairing never makes a restart bind every interface.
    reach: caller.pairingReach ?? 'network',
    exposure: 'as-bound'
  } as const
  if (params.connectionMode !== 'local-only') {
    // The server's own Relay sign-in and team policy decide whether it can mint here.
    const relayed = await server.createMobilePairingOffer({ ...offer, connectionMode: 'automatic' })
    // A newer request took the mint's turn: retrying beats a LAN-only pairing that refuses Relay.
    if (
      relayed.available ||
      !address ||
      relayed.relayFailure?.code === 'relay_request_superseded'
    ) {
      return answer(relayed)
    }
  }
  if (!address) {
    return { available: false, reason: 'no_route', guidance: NO_ROUTE_GUIDANCE }
  }
  return answer(await server.createMobilePairingOffer({ ...offer, connectionMode: 'local-only' }))
}

function answer(offer: MobilePairingOffer): DelegatedPhoneServerOfferResult {
  if (!offer.available) {
    return { available: false, reason: offer.reason, guidance: phoneGuidance(offer) }
  }
  return {
    available: true,
    pairingUrl: offer.pairingUrl,
    connectionMode: offer.connectionMode
  }
}

// The phone can act only on the server's Relay sign-in; anything else is worth one more try.
function phoneGuidance(offer: PairingOfferUnavailable): string {
  switch (offer.relayFailure?.code) {
    case undefined:
      return offer.reason === 'relay_mint_failed' ? NO_ROUTE_GUIDANCE : offer.guidance
    case 'relay_signed_out':
      return NO_ROUTE_GUIDANCE
    case 'relay_not_entitled':
      return 'Orca Relay isn’t included with the Orca account this server is signed in to.'
    default:
      return 'Orca Relay could not create a pairing invite for this server. Try again.'
  }
}
