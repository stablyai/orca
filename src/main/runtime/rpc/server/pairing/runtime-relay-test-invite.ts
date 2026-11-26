import {
  encodePairingOffer,
  parsePairingCode
} from '../../../../../shared/remote-runtime/pairing/pairing'
import { runtimeRelayPairingTestSwitchOn } from '../../../../../shared/remote-runtime/pairing/runtime-relay-endpoint'
import type { RelayDeviceBinding } from '../../../mobile-cloud-relay/pairing/relay-revoke-outbox'
import {
  pairingUnavailable,
  type MobileRelayPairingProvider,
  type PairingOfferUnavailable
} from '../runtime-rpc-pairing-types'

/**
 * Test-only, dev builds (runtime-relay-endpoint.ts): adds a Relay invite to a paired-desktop offer,
 * as a phone offer carries one, and binds the device to it. Off, the offer is returned as is.
 */
export async function withTestRelayInvite<T extends { pairingUrl: string; deviceId: string }>(
  offer: T,
  host: {
    provider: () => Promise<MobileRelayPairingProvider | null>
    bind: (deviceId: string, binding: RelayDeviceBinding) => Promise<boolean>
    retain: (deviceId: string, binding: RelayDeviceBinding) => void
  }
): Promise<T | PairingOfferUnavailable> {
  if (!runtimeRelayPairingTestSwitchOn()) {
    return offer
  }
  const provider = await host.provider()
  const direct = parsePairingCode(offer.pairingUrl)
  if (!provider || !direct) {
    return pairingUnavailable('relay_mint_failed', 'Orca Relay is not available on this host.')
  }
  let minted: Awaited<ReturnType<MobileRelayPairingProvider['createPairingRelay']>>
  try {
    minted = await provider.createPairingRelay(offer.deviceId)
  } catch {
    return pairingUnavailable('relay_mint_failed', 'Could not create a Relay invite.')
  }
  const { relay, binding } = minted
  if (!(await host.bind(offer.deviceId, binding))) {
    host.retain(offer.deviceId, binding)
    return pairingUnavailable('relay_mint_failed', 'Could not store the Relay binding.')
  }
  // Relay offers refuse the runtime scope until desktops pair over Relay; scopeless pairs one.
  const { scope: _scope, ...rest } = direct
  return { ...offer, pairingUrl: encodePairingOffer({ ...rest, relay }) }
}
