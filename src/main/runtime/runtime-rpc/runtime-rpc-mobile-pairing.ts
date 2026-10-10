import type { MobilePairingConnectionMode } from '../../../shared/mobile-pairing-connection-mode'
import {
  mobileRelayMintFailureFromUnknown,
  type MobileRelayMintFailure
} from '../../../shared/mobile-relay-mint-failure'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../../shared/pairing'
import { NETWORK_EXPOSURE_FAILED_GUIDANCE } from '../network-exposure-guidance'
import { RuntimeRpcPairing } from './runtime-rpc-pairing'
import {
  DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE,
  pairingUnavailable,
  type MobilePairingOffer,
  type MobileRelayPairingProvider,
  type PairingOfferUnavailable
} from './runtime-rpc-pairing-types'

export class RuntimeRpcMobilePairing extends RuntimeRpcPairing {
  async createMobilePairingOffer(args: {
    address?: string | null
    connectionMode?: MobilePairingConnectionMode
    name?: string
    rotate?: boolean
  }): Promise<MobilePairingOffer> {
    // Why: STA-2370 — creating a mobile pairing offer is the user's explicit opt-in to LAN reach, so
    // widen the loopback listener before advertising its LAN endpoint in the QR. If the widen fails the
    // listener stays on loopback, so report unavailable rather than advertise a dead LAN endpoint.
    try {
      await this.ensureNetworkExposure()
    } catch (error) {
      console.error(
        '[runtime] Network exposure failed while creating a mobile pairing offer:',
        error
      )
      return pairingUnavailable('network_exposure_failed', NETWORK_EXPOSURE_FAILED_GUIDANCE)
    }
    if (args.connectionMode === 'local-only') {
      this.mobilePairingOfferGeneration += 1
      return this.createMobilePairingOfferSerial(args, this.mobilePairingOfferGeneration)
    }
    const address = args.address ?? null
    const rotate = args.rotate === true
    const inFlight = this.mobileRelayPairingOfferInFlight
    if (
      inFlight?.generation === this.mobilePairingOfferGeneration &&
      inFlight.address === address &&
      (inFlight.rotate || !rotate)
    ) {
      return inFlight.request
    }
    // Why: every request that is not coalesced above supersedes the older one, rotating or not.
    const generation = ++this.mobilePairingOfferGeneration
    const request = this.mobileRelayPairingOfferQueue.then(() =>
      generation === this.mobilePairingOfferGeneration
        ? this.createMobilePairingOfferSerial(args, generation)
        : this.relayPairingRequestSuperseded()
    )
    this.mobileRelayPairingOfferQueue = request.then(
      () => undefined,
      () => undefined
    )
    this.mobileRelayPairingOfferInFlight = { generation, address, rotate, request }
    void request.then(
      () => {
        if (this.mobileRelayPairingOfferInFlight?.request === request) {
          this.mobileRelayPairingOfferInFlight = null
        }
      },
      () => {
        if (this.mobileRelayPairingOfferInFlight?.request === request) {
          this.mobileRelayPairingOfferInFlight = null
        }
      }
    )
    return request
  }

  protected async createMobilePairingOfferSerial(
    args: {
      address?: string | null
      connectionMode?: MobilePairingConnectionMode
      name?: string
      rotate?: boolean
    },
    generation: number
  ): Promise<MobilePairingOffer> {
    // Why: the renderer is outside the trust boundary, so only an explicit local-only value may suppress Relay provisioning.
    const connectionMode = args.connectionMode === 'local-only' ? 'local-only' : 'automatic'
    const pending = this.deviceRegistry?.getPendingDevice('mobile')
    // Why: connection policy is part of the credential, so rotate on any policy switch — an old-policy QR must not pair under the new one.
    const switchingPendingMode =
      pending != null &&
      this.deviceRegistry?.getMobilePairingConnectionMode(pending.deviceId) !== connectionMode
    if (args.rotate || switchingPendingMode) {
      if (pending?.relayBinding) {
        // Why: record the durable cloud revoke before rotating the local token so an old relay invite can't outlive the QR.
        if (!this.queueRelayDeviceRevoke(pending.relayBinding)) {
          return pairingUnavailable(
            'device_registry_unavailable',
            'Could not persist Relay cleanup before rotating the pairing code.'
          )
        }
      }
    }
    const direct = this.createPairingOffer({
      ...args,
      rotate: args.rotate || switchingPendingMode,
      scope: 'mobile'
    })
    if (!direct.available) {
      return direct
    }
    const createdNewPendingDevice = pending?.deviceId !== direct.deviceId
    let connectionModeStored = false
    try {
      connectionModeStored =
        this.deviceRegistry?.setMobilePairingConnectionMode(direct.deviceId, connectionMode) ??
        false
    } catch (error) {
      console.error('[runtime] Failed to persist the pairing connection mode:', error)
    }
    // Why: the mode is part of the credential — a QR whose policy was never stored must not pair under the default one.
    if (!connectionModeStored) {
      if (createdNewPendingDevice) {
        this.discardPendingMobilePairingDevice(direct.deviceId)
      }
      return pairingUnavailable('device_registry_unavailable', DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE)
    }
    // Why: explicit LAN path never needs Relay; mint the direct-only offer as selected.
    if (connectionMode === 'local-only') {
      return { ...direct, connectionMode: 'local-only' }
    }
    // Why: Anywhere must not silently ship a LAN-only QR under the Relay label.
    // Fail closed, drop the unused pending credential, and let the UI offer Use LAN.
    const refuseAutomaticWithoutRelay = (
      relayFailure: MobileRelayMintFailure
    ): PairingOfferUnavailable => {
      if (createdNewPendingDevice) {
        this.discardPendingMobilePairingDevice(direct.deviceId)
      }
      return {
        available: false,
        reason: 'relay_mint_failed',
        guidance:
          'Orca Relay could not create a pairing invite. Use LAN (Tailscale or same Wi‑Fi) or retry Relay.',
        relayFailure
      }
    }
    const relayProvider = this.mobileRelayPairingProvider
    if (!relayProvider) {
      return refuseAutomaticWithoutRelay({
        code: 'relay_provider_unavailable',
        stage: 'provider_missing',
        message: 'Orca Relay is not available on this desktop'
      })
    }
    const device = this.deviceRegistry?.getDevice(direct.deviceId)
    const publicKeyB64 = this.getE2EEPublicKey()
    if (!device || !publicKeyB64) {
      return refuseAutomaticWithoutRelay({
        code: 'e2ee_key_unavailable',
        stage: 'e2ee_missing',
        message: 'E2EE public key unavailable for Relay pairing'
      })
    }
    let relayPairing: Awaited<ReturnType<MobileRelayPairingProvider['createPairingRelay']>>
    try {
      relayPairing = await relayProvider.createPairingRelay(device.deviceId)
    } catch (error) {
      // Why: the raw provider error can carry request metadata or credentials — log only the validated code.
      const relayFailure = mobileRelayMintFailureFromUnknown({
        stage: 'create_pairing_relay',
        error,
        fallbackCode: 'relay_mint_failed',
        fallbackMessage: 'Relay pairing invite request failed'
      })
      console.warn(`[runtime] Failed to create Relay pairing invite: ${relayFailure.code}`)
      return refuseAutomaticWithoutRelay(relayFailure)
    }
    const currentDevice = this.deviceRegistry?.getDevice(device.deviceId)
    if (
      generation !== this.mobilePairingOfferGeneration ||
      relayProvider !== this.mobileRelayPairingProvider ||
      currentDevice?.token !== device.token ||
      this.deviceRegistry?.getMobilePairingConnectionMode(device.deviceId) !== 'automatic'
    ) {
      this.queueOrRetainRelayDeviceRevoke(device.deviceId, relayPairing.binding)
      if (createdNewPendingDevice) {
        this.discardPendingMobilePairingDevice(direct.deviceId)
      }
      return this.relayPairingRequestSuperseded()
    }
    try {
      if (!this.setMobileRelayBinding(device.deviceId, relayPairing.binding)) {
        this.queueOrRetainRelayDeviceRevoke(device.deviceId, relayPairing.binding)
        return refuseAutomaticWithoutRelay({
          code: 'relay_binding_failed',
          stage: 'binding_failed',
          message: 'Could not store Relay binding for the pairing device'
        })
      }
    } catch (error) {
      console.warn('[runtime] Failed to persist Relay pairing binding:', error)
      this.queueOrRetainRelayDeviceRevoke(device.deviceId, relayPairing.binding)
      return refuseAutomaticWithoutRelay({
        code: 'relay_binding_failed',
        stage: 'binding_failed',
        message: 'Could not store Relay binding for the pairing device'
      })
    }
    return {
      ...direct,
      connectionMode: 'automatic',
      pairingUrl: encodePairingOffer({
        v: PAIRING_OFFER_VERSION,
        endpoint: direct.endpoint,
        deviceToken: device.token,
        publicKeyB64,
        pairedDeviceId: device.deviceId,
        scope: 'mobile',
        relay: relayPairing.relay
      })
    }
  }

  protected relayPairingRequestSuperseded(): PairingOfferUnavailable {
    return {
      available: false,
      reason: 'relay_mint_failed',
      guidance: 'The Relay pairing request was replaced by a newer connection choice.',
      relayFailure: {
        code: 'relay_request_superseded',
        stage: 'binding_failed',
        message: 'Relay pairing request superseded'
      }
    }
  }

  /** Drop a never-scanned mobile pending credential after a failed Anywhere mint. */
  protected discardPendingMobilePairingDevice(deviceId: string): void {
    const device = this.deviceRegistry?.getDevice(deviceId)
    if (!device || device.scope !== 'mobile' || device.lastSeenAt !== 0) {
      return
    }
    if (device.relayBinding) {
      if (!this.queueRelayDeviceRevoke(device.relayBinding)) {
        return
      }
    }
    try {
      this.deviceRegistry?.removeDevice(deviceId)
    } catch (error) {
      console.error('[runtime] Failed to drop an unused mobile pairing credential:', error)
    }
  }

  /**
   * Why: the outbox is the only durable cleanup record for a minted invite. When it can't be
   * written, keep the binding on the device so cleanup keeps a reference instead of orphaning it.
   */
}
