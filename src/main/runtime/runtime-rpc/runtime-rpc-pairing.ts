import type { PairingIroh } from '../../../shared/mobile-relay-pairing-offer'
import { isMobilePairingRelayDisabled } from '../../../shared/mobile-pairing-connection-mode'
import type { DeviceEntry, DeviceRegistry, DeviceScope } from '../device-registry'
import type { E2EEKeypair } from '../e2ee-keypair'
import type { MobileSocketWiring } from '../rpc/mobile-socket-wiring'
import type {
  RelayDeviceBinding,
  RelayRevokeOutbox,
  RelayRevokeOutboxItem
} from '../relay/relay-revoke-outbox'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../../shared/pairing'
import type { RuntimePairingReach } from '../../../shared/runtime-pairing-reach'
import { resolveAdvertisedPairingEndpoint } from '../pairing-endpoint'
import { RuntimeRpcNetworkExposure } from './runtime-rpc-network-exposure'
import {
  createWebClientUrl,
  DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE,
  E2EE_KEY_UNAVAILABLE_GUIDANCE,
  pairingUnavailable,
  type MobileRelayPairingProvider,
  type PairingOfferUnavailable
} from './runtime-rpc-pairing-types'

export class RuntimeRpcPairing extends RuntimeRpcNetworkExposure {
  getIrohEndpointId(): string | null {
    return this.irohTransport?.endpointId ?? null
  }

  protected getIrohPairingTarget(): PairingIroh | null {
    const endpointId = this.irohTransport?.endpointId
    if (!endpointId) {
      return null
    }
    const hints = this.irohTransport?.endpointDialHints() ?? null
    return {
      endpointId,
      ...(hints?.relayUrl ? { relayUrl: hints.relayUrl } : {}),
      ...(hints && hints.directAddresses.length > 0
        ? { directAddresses: hints.directAddresses }
        : {})
    }
  }

  getDeviceRegistry(): DeviceRegistry | null {
    return this.deviceRegistry
  }

  getTlsFingerprint(): string | null {
    return this.tlsFingerprint
  }

  getE2EEPublicKey(): string | null {
    return this.e2eeKeypair?.publicKeyB64 ?? null
  }

  getE2EEKeypair(): E2EEKeypair | null {
    return this.e2eeKeypair
  }

  getMobileSocketWiring(): MobileSocketWiring | null {
    return this.mobileSocketWiring
  }

  getRelayRevokeOutbox(): RelayRevokeOutbox {
    return this.relayRevokeOutbox
  }

  setMobileRelayBinding(deviceId: string, binding: RelayDeviceBinding): boolean {
    const current = this.deviceRegistry?.getDevice(deviceId)
    const pairingMode = this.deviceRegistry?.getMobilePairingConnectionMode(deviceId)
    if (
      current?.scope !== 'mobile' ||
      (pairingMode != null && isMobilePairingRelayDisabled(pairingMode))
    ) {
      return false
    }
    if (
      current.relayBinding &&
      (current.relayBinding.relayHostId !== binding.relayHostId ||
        current.relayBinding.ownerIdentityKey !== binding.ownerIdentityKey)
    ) {
      // Why: switching the owning account/host must not strand the old cloud credential family, even if that account is offline.
      if (!this.queueRelayDeviceRevoke(current.relayBinding)) {
        return false
      }
    }
    const updated = this.deviceRegistry?.setRelayBinding(deviceId, binding) ?? false
    if (updated) {
      this.mobileRelayPairingProvider?.onDemandStateChanged?.()
    }
    return updated
  }

  // Why: only the desktop shell can surface UI; headless serve leaves this unset.
  setOnUnpairedDeviceAuthFailure(callback: (() => void) | null): void {
    this.onUnpairedDeviceAuthFailure = callback
  }

  setMobileRelayPairingProvider(provider: MobileRelayPairingProvider | null): void {
    this.mobileRelayPairingProvider = provider
  }

  async revokeMobileDevice(deviceId: string): Promise<boolean> {
    const device = this.deviceRegistry?.getDevice(deviceId)
    if (device?.scope !== 'mobile') {
      return false
    }
    if (device.relayBinding) {
      if (!this.queueRelayDeviceRevoke(device.relayBinding)) {
        return false
      }
    }
    if (!this.deviceRegistry?.removeDevice(deviceId)) {
      return false
    }
    this.mobileRelayPairingProvider?.onDemandStateChanged?.()
    this.runtime.forgetClientNavigationState(deviceId)
    this.mobileSocketWiring?.terminateDeviceConnections(device.token)
    return true
  }

  revokeRuntimeAccess(deviceId: string): boolean {
    const device = this.deviceRegistry?.getDevice(deviceId)
    if (device?.scope !== 'runtime' || !this.deviceRegistry?.removeDevice(deviceId)) {
      return false
    }
    this.runtime.forgetClientNavigationState(deviceId)
    this.mobileSocketWiring?.terminateDeviceConnections(device.token)
    return true
  }

  getWebSocketEndpoint(): string | null {
    const ws = this.transports.find((t) => t.kind === 'websocket')
    return ws?.endpoint ?? null
  }

  createPairingOffer(args: {
    address?: string | null
    name?: string
    rotate?: boolean
    scope?: DeviceScope
    // Why: only iroh-mode mobile offers may carry the iroh dial target — a
    // local-only QR advertising it would grant off-LAN reachability via the
    // public relay, breaking the "same network only" promise.
    includeIroh?: boolean
    // Why: STA-2370 — recorded on the grant so a "This computer only" client reconnecting cannot make the
    // next launch bind every interface. Defaults to network reach, which is what every other caller means.
    reach?: RuntimePairingReach
  }):
    | PairingOfferUnavailable
    | {
        available: true
        pairingUrl: string
        endpoint: string
        deviceId: string
        webClientUrl: string | null
      } {
    if (this.pairingInitializationFailure) {
      return this.pairingInitializationFailure
    }
    const iroh = args.includeIroh ? this.getIrohPairingTarget() : null
    if (args.includeIroh && !iroh) {
      return pairingUnavailable(
        'iroh_unavailable',
        'Iroh pairing is unavailable. Restart Orca or inspect the Iroh transport logs.'
      )
    }
    const rawEndpoint = this.getWebSocketEndpoint()
    let endpoint: string
    if (!rawEndpoint) {
      if (!iroh) {
        return pairingUnavailable(
          'websocket_unavailable',
          'WebSocket pairing is unavailable. Inspect preceding runtime errors and choose an unused --port if the listener failed.'
        )
      }
      endpoint = `iroh://${iroh.endpointId}`
    } else if (iroh && !args.address) {
      endpoint = `iroh://${iroh.endpointId}`
    } else {
      const advertised = resolveAdvertisedPairingEndpoint(rawEndpoint, args.address)
      if (!advertised.ok) {
        return pairingUnavailable(advertised.reason, advertised.guidance)
      }
      endpoint = advertised.endpoint
    }
    if (!this.deviceRegistry) {
      return pairingUnavailable('device_registry_unavailable', DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE)
    }
    const publicKeyB64 = this.getE2EEPublicKey()
    if (!publicKeyB64) {
      return pairingUnavailable('e2ee_key_unavailable', E2EE_KEY_UNAVAILABLE_GUIDANCE)
    }

    const deviceName = args.name ?? `CLI ${new Date().toLocaleDateString()}`
    const scope = args.scope ?? 'runtime'
    let device: DeviceEntry
    try {
      const reach = args.reach ?? 'network'
      device = args.rotate
        ? this.deviceRegistry.rotatePendingDevice(deviceName, scope, reach)
        : this.deviceRegistry.getOrCreatePendingDevice(deviceName, scope, reach)
    } catch (error) {
      console.error('[runtime] Failed to persist pairing credential:', error)
      return pairingUnavailable('device_registry_unavailable', DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE)
    }
    const pairingUrl = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint,
      deviceToken: device.token,
      publicKeyB64,
      pairedDeviceId: device.deviceId,
      scope,
      ...(iroh ? { iroh } : {})
    })
    return {
      available: true,
      pairingUrl,
      endpoint,
      deviceId: device.deviceId,
      webClientUrl:
        this.webClientRoot && scope === 'runtime' ? createWebClientUrl(endpoint, pairingUrl) : null
    }
  }

  protected queueOrRetainRelayDeviceRevoke(deviceId: string, binding: RelayDeviceBinding): void {
    if (this.queueRelayDeviceRevoke(binding)) {
      return
    }
    try {
      this.deviceRegistry?.setRelayBinding(deviceId, binding)
    } catch (error) {
      console.error('[runtime] Failed to retain an unrevoked Relay binding:', error)
    }
  }

  protected queueRelayDeviceRevoke(binding: RelayDeviceBinding): boolean {
    let item: RelayRevokeOutboxItem
    try {
      item = this.relayRevokeOutbox.enqueue(binding)
    } catch (error) {
      console.error('[runtime] Failed to persist Relay device cleanup:', error)
      return false
    }
    try {
      this.mobileRelayPairingProvider?.onDeviceRevokeQueued(item)
    } catch (error) {
      console.warn('[runtime] Failed to notify Relay cleanup worker:', error)
    }
    return true
  }
}
