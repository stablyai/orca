import type { PairingOffer } from '../../../src/shared/remote-runtime/pairing/mobile-relay-pairing-offer'

/** A runtime-scope link pairs as another Orca: the host refuses the phone's capabilities and hides its chats. */
export class RuntimeAccessLinkError extends Error {
  constructor() {
    super('pairing link is for another Orca client, not Orca Mobile')
  }
}

export function assertMobilePairingOffer(offer: PairingOffer): void {
  if (offer.scope === 'runtime') {
    throw new RuntimeAccessLinkError()
  }
}
