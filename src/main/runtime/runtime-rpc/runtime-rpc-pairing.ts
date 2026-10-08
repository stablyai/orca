import type { DeviceEntry, DeviceRegistry, DeviceScope } from '../device-registry'
import type { E2EEKeypair } from '../e2ee-keypair'
import type { MobileSocketWiring } from '../rpc/mobile-socket-wiring'
import type { RelayDeviceBinding, RelayRevokeOutbox } from '../relay/relay-revoke-outbox'
import type { PushUnregisterOutbox } from '../push/push-unregister-outbox'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../../shared/pairing'
import type { RuntimePairingReach } from '../../../shared/runtime-pairing-reach'
import { resolveAdvertisedPairingEndpoint } from '../pairing-endpoint'
import { RuntimeRpcNetworkExposure } from './runtime-rpc-network-exposure'
import { MobileDesktopRelay } from '../mobile-desktop-relay/mobile-desktop-relay'
import type { MobileDesktopRelayHosts } from '../mobile-desktop-relay/mobile-desktop-relay-hosts'
import { MobileRelayHostCatalog } from '../mobile-desktop-relay/mobile-relay-host-catalog'
import { getHostDisplayLabelOverrides } from '../../../shared/host-setting-overrides'
import { DELEGATED_PHONE_NAME_MAX_CHARS } from '../../../shared/delegated-mobile-device-contract'
import { allocateTerminalSubscriptionStreamId } from '../rpc/methods/terminal/terminal-subscription-stream-id'
import {
  createWebClientUrl,
  DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE,
  E2EE_KEY_UNAVAILABLE_GUIDANCE,
  pairingUnavailable,
  type MobileRelayPairingProvider,
  type PairingOfferUnavailable
} from './runtime-rpc-pairing-types'

export class RuntimeRpcPairing extends RuntimeRpcNetworkExposure {
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

  getPushUnregisterOutbox(): PushUnregisterOutbox {
    return this.pushUnregisterOutbox
  }

  setMobileRelayBinding(deviceId: string, binding: RelayDeviceBinding): boolean {
    const current = this.deviceRegistry?.getDevice(deviceId)
    if (
      current?.scope !== 'mobile' ||
      this.deviceRegistry?.getMobilePairingConnectionMode(deviceId) === 'local-only'
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

  setMobileDesktopRelayHosts(hosts: MobileDesktopRelayHosts | null): void {
    this.mobileDesktopRelay?.dispose()
    this.mobileDesktopRelay = hosts
      ? new MobileDesktopRelay({
          hosts,
          listPhones: () => this.listRelayedPhones(),
          // Why: one allocator with local streams, so relayed ids never collide on the phone's socket.
          allocateStreamId: allocateTerminalSubscriptionStreamId
        })
      : null
    this.mobileRelayHostCatalog = hosts
      ? new MobileRelayHostCatalog({
          hosts,
          hostLabelOverrides: () => getHostDisplayLabelOverrides(this.runtime.getClientSettings())
        })
      : null
  }

  private listRelayedPhones(): { phoneKey: string; name: string }[] {
    const computerName = this.runtime.readMachineName()
    return (this.deviceRegistry?.listDevices() ?? [])
      .filter(
        // Why: phones another desktop relays here are that desktop's to relay, not ours.
        (device) =>
          device.scope === 'mobile' && device.lastSeenAt > 0 && device.parentDeviceId === undefined
      )
      .map((device) => ({
        phoneKey: device.deviceId,
        name: `${device.name} via ${computerName}`.slice(0, DELEGATED_PHONE_NAME_MAX_CHARS)
      }))
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
    const rawEndpoint = this.getWebSocketEndpoint()
    if (!rawEndpoint) {
      return pairingUnavailable(
        'websocket_unavailable',
        'WebSocket pairing is unavailable. Inspect preceding runtime errors and choose an unused --port if the listener failed.'
      )
    }
    if (!this.deviceRegistry) {
      return pairingUnavailable('device_registry_unavailable', DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE)
    }
    const publicKeyB64 = this.getE2EEPublicKey()
    if (!publicKeyB64) {
      return pairingUnavailable('e2ee_key_unavailable', E2EE_KEY_UNAVAILABLE_GUIDANCE)
    }

    const advertised = resolveAdvertisedPairingEndpoint(rawEndpoint, args.address)
    if (!advertised.ok) {
      return pairingUnavailable(advertised.reason, advertised.guidance)
    }
    const endpoint = advertised.endpoint
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
      scope
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
}
