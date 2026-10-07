import type { RuntimeRelayPairingUrlResult } from '../../shared/runtime-access-grants'
import { NETWORK_EXPOSURE_FAILED_GUIDANCE } from '../runtime/network-exposure-guidance'
import {
  getDefaultPairingAddress,
  type DefaultRouteInterfaceLookup
} from '../runtime/pairing-network-interfaces'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { readRelayAccountFailure } from '../startup/serve-relay-pairing'

const LOOPBACK_ADDRESS = '127.0.0.1'

const SIGN_IN_GUIDANCE = 'Sign in to an Orca account to share this server through Orca Relay.'

const RELAY_MINT_FAILED_GUIDANCE =
  'Orca Relay could not create an invite. Check this computer’s internet connection and try again, or share over LAN or Tailscale.'

/**
 * "Any network" share: a runtime grant whose link carries an Orca Relay invite. The link still
 * names this computer's LAN or Tailscale address, which the other client tries before Relay.
 */
export async function createRuntimeRelayPairingUrl(
  rpcServer: Pick<
    OrcaRuntimeRpcServer,
    'ensureNetworkExposure' | 'createRuntimeRelayPairingOffer' | 'revokeRuntimeAccess'
  >,
  getDefaultRouteInterfaceNames: DefaultRouteInterfaceLookup
): Promise<RuntimeRelayPairingUrlResult> {
  const accountFailure = await readRelayAccountFailure(SIGN_IN_GUIDANCE)
  if (accountFailure) {
    return { available: false, reason: accountFailure.code, guidance: accountFailure.guidance }
  }
  const lanAddress = await getDefaultPairingAddress(getDefaultRouteInterfaceNames)
  if (lanAddress) {
    try {
      await rpcServer.ensureNetworkExposure()
    } catch (error) {
      console.error('[mobile] Network exposure failed while creating a Relay runtime offer:', error)
      return {
        available: false,
        reason: 'network_exposure_failed',
        guidance: NETWORK_EXPOSURE_FAILED_GUIDANCE
      }
    }
  }
  const offer = await rpcServer.createRuntimeRelayPairingOffer({
    // Why: with no LAN or Tailscale address the link is Relay-only, and loopback needs no wider listener.
    address: lanAddress ?? LOOPBACK_ADDRESS,
    reach: lanAddress ? 'network' : 'this-computer',
    rotate: true,
    name: `Runtime ${new Date().toLocaleDateString()}`
  })
  if (!offer.available) {
    return { available: false, reason: offer.reason, guidance: offer.guidance }
  }
  if (!offer.relay.available) {
    // Why: an "any network" link must not silently be LAN-only, so drop the grant it would have used.
    rpcServer.revokeRuntimeAccess(offer.deviceId)
    return {
      available: false,
      reason: offer.relay.failure.code,
      guidance: RELAY_MINT_FAILED_GUIDANCE
    }
  }
  return {
    available: true,
    pairingUrl: offer.relay.pairingUrl,
    inviteExpiresAt: offer.relay.inviteExpiresAt,
    deviceId: offer.deviceId
  }
}
