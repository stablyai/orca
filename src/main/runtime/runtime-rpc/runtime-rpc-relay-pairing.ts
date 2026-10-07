import {
  mobileRelayMintFailureFromUnknown,
  type MobileRelayMintFailure
} from '../../../shared/mobile-relay-mint-failure'
import type { PairingRelay } from '../../../shared/mobile-relay-pairing-offer'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../../shared/pairing'
import type { RuntimePairingReach } from '../../../shared/runtime-pairing-reach'
import { RuntimeRpcPairing } from './runtime-rpc-pairing'
import type {
  MobileRelayPairingProvider,
  PairingOfferUnavailable,
  RuntimeRelayPairingOffer
} from './runtime-rpc-pairing-types'

export type PairingRelayMint =
  | { kind: 'minted'; relay: PairingRelay; deviceToken: string; publicKeyB64: string }
  | { kind: 'failed'; failure: MobileRelayMintFailure }
  | { kind: 'superseded' }

const RELAY_BINDING_FAILURE: MobileRelayMintFailure = {
  code: 'relay_binding_failed',
  stage: 'binding_failed',
  message: 'Could not store Relay binding for the pairing device'
}

export class RuntimeRpcRelayPairing extends RuntimeRpcPairing {
  /** Runtime-scoped offer with a Relay invite; the direct offer survives a failed Relay mint. */
  async createRuntimeRelayPairingOffer(args: {
    address?: string | null
    name?: string
    rotate?: boolean
    reach?: RuntimePairingReach
  }): Promise<PairingOfferUnavailable | RuntimeRelayPairingOffer> {
    const direct = this.createPairingOffer({ ...args, scope: 'runtime' })
    if (!direct.available) {
      return direct
    }
    const minted = await this.mintPairingRelay(direct.deviceId)
    if (minted.kind !== 'minted') {
      return {
        ...direct,
        relay: {
          available: false,
          failure:
            minted.kind === 'failed'
              ? minted.failure
              : {
                  code: 'relay_request_superseded',
                  stage: 'binding_failed',
                  message: 'Relay pairing request superseded'
                }
        }
      }
    }
    return {
      ...direct,
      relay: {
        available: true,
        pairingUrl: encodePairingOffer({
          v: PAIRING_OFFER_VERSION,
          endpoint: direct.endpoint,
          deviceToken: minted.deviceToken,
          publicKeyB64: minted.publicKeyB64,
          pairedDeviceId: direct.deviceId,
          scope: 'runtime',
          relay: minted.relay
        }),
        inviteExpiresAt: minted.relay.inviteExpiresAt
      }
    }
  }

  /** Mints a Relay invite for a pending device and records its binding before the offer can leave. */
  protected async mintPairingRelay(
    deviceId: string,
    isCurrent: () => boolean = () => true
  ): Promise<PairingRelayMint> {
    const relayProvider = this.mobileRelayPairingProvider
    if (!relayProvider) {
      return {
        kind: 'failed',
        failure: {
          code: 'relay_provider_unavailable',
          stage: 'provider_missing',
          message: 'Orca Relay is not available on this desktop'
        }
      }
    }
    const device = this.deviceRegistry?.getDevice(deviceId)
    const publicKeyB64 = this.getE2EEPublicKey()
    if (!device || !publicKeyB64) {
      return {
        kind: 'failed',
        failure: {
          code: 'e2ee_key_unavailable',
          stage: 'e2ee_missing',
          message: 'E2EE public key unavailable for Relay pairing'
        }
      }
    }
    let relayPairing: Awaited<ReturnType<MobileRelayPairingProvider['createPairingRelay']>>
    try {
      relayPairing = await relayProvider.createPairingRelay(device.deviceId)
    } catch (error) {
      // Why: the raw provider error can carry request metadata or credentials — log only the validated code.
      const failure = mobileRelayMintFailureFromUnknown({
        stage: 'create_pairing_relay',
        error,
        fallbackCode: 'relay_mint_failed',
        fallbackMessage: 'Relay pairing invite request failed'
      })
      console.warn(`[runtime] Failed to create Relay pairing invite: ${failure.code}`)
      return { kind: 'failed', failure }
    }
    const currentDevice = this.deviceRegistry?.getDevice(device.deviceId)
    if (
      !isCurrent() ||
      relayProvider !== this.mobileRelayPairingProvider ||
      currentDevice?.token !== device.token
    ) {
      this.queueOrRetainRelayDeviceRevoke(device.deviceId, relayPairing.binding)
      return { kind: 'superseded' }
    }
    try {
      if (!this.setDeviceRelayBinding(device.deviceId, relayPairing.binding)) {
        this.queueOrRetainRelayDeviceRevoke(device.deviceId, relayPairing.binding)
        return { kind: 'failed', failure: RELAY_BINDING_FAILURE }
      }
    } catch (error) {
      console.warn('[runtime] Failed to persist Relay pairing binding:', error)
      this.queueOrRetainRelayDeviceRevoke(device.deviceId, relayPairing.binding)
      return { kind: 'failed', failure: RELAY_BINDING_FAILURE }
    }
    return { kind: 'minted', relay: relayPairing.relay, deviceToken: device.token, publicKeyB64 }
  }
}
