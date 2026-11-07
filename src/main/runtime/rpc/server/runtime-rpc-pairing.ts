import type { PairingIroh } from '../../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import { isMobilePairingRelayDisabled } from '../../../../shared/remote-runtime/pairing/mobile-pairing-connection-mode'
import type { RuntimeDeviceGrant } from '../rpc-method-permission'
import type { DeviceRegistry } from './pairing/device-registry'
import type { DeviceScope } from '../../../../shared/runtime-session-contracts'
import type { TokenDeviceEntry } from './pairing/device-entry'
import type { E2EEKeypair } from '../../e2ee-keypair'
import type { MobileSocketWiring } from '../mobile-socket-wiring'
import type {
  RelayDeviceBinding,
  RelayRevokeOutbox
} from '../../mobile-cloud-relay/relay-revoke-outbox'
import type { PushUnregisterOutbox } from '../../push/push-unregister-outbox'
import { encodePairingOffer } from '../../../../shared/remote-runtime/pairing/pairing'
import { PAIRING_OFFER_VERSION } from '../../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import type { RuntimePairingReach } from '../../../../shared/runtime-pairing-reach'
import { resolveAdvertisedPairingEndpoint } from '../../pairing-endpoint'
import { RuntimeRpcNetworkExposure } from './runtime-rpc-network-exposure'
import { MobileDesktopRelay } from '../../mobile-desktop-relay/mobile-desktop-relay'
import type { MobileDesktopRelayHosts } from '../../mobile-desktop-relay/mobile-desktop-relay-hosts'
import { MobileRelayHostCatalog } from '../../mobile-desktop-relay/mobile-relay-host-catalog'
import { OnDemandServerWorktreeRows } from '../../mobile-desktop-relay/on-demand-server-worktree-rows'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import { DELEGATED_PHONE_NAME_MAX_CHARS } from '../../../../shared/delegated-mobile-device-contract'
import { allocateTerminalSubscriptionStreamId } from '../methods/terminal/terminal-subscription-stream-id'
import { isStructuredNativeChatDefaultFor } from '../methods/structured-sessions/structured-agent-session-policy'
import {
  createWebClientUrl,
  DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE,
  E2EE_KEY_UNAVAILABLE_GUIDANCE,
  pairingUnavailable,
  type MobileRelayPairingProvider,
  type PairingOfferUnavailable
} from './runtime-rpc-pairing-types'

export class RuntimeRpcPairing extends RuntimeRpcNetworkExposure {
  /** Expose only the current relay generation's online endpoint, never a superseded bind. */
  getIrohStatus(): { bound: boolean; endpointId: string | null; relayUrl: string | null } {
    const endpointId =
      !this.stopping && this.appliedIrohRelayGeneration === this.irohRelayGeneration
        ? (this.irohTransport?.endpointId ?? null)
        : null
    return {
      bound: endpointId !== null,
      endpointId,
      relayUrl: endpointId ? (this.irohTransport?.endpointDialHints()?.relayUrl ?? null) : null
    }
  }

  /** Build bounded pairing dial hints only when the selected iroh endpoint is ready. */
  protected getIrohPairingTarget(): PairingIroh | null {
    const { endpointId } = this.getIrohStatus()
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

  /** Store Relay bindings only for eligible mobile grants, revoking replaced credential families. */
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
      // Switching account/host must durably revoke the old cloud credential family even while that account is offline.
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

  setMobileRelayPairingProviderInstaller(install: (() => Promise<unknown>) | null): void {
    this.mobileRelayPairingProviderInstaller = install
  }

  setMobileDesktopRelayHosts(hosts: MobileDesktopRelayHosts | null): void {
    this.mobileDesktopRelay?.dispose()
    this.mobileDesktopRelay = hosts
      ? new MobileDesktopRelay({
          hosts,
          listPhones: () => this.listRelayedPhones(),
          // Share local stream allocator so relayed ids cannot collide on phone sockets.
          allocateStreamId: allocateTerminalSubscriptionStreamId,
          nativeChatDefault: (agent) => isStructuredNativeChatDefaultFor(this.runtime, agent),
          prepareBrowserHost: async (host) => {
            if (this.runtime.getStatus().capabilities?.includes('browser.screencast.v1')) {
              const placement = await hosts.prepareBrowserHost?.(
                host,
                this.runtime.requireStore().getSettings().browserClientHostedRemoteEnabled !== false
              )
              return placement?.kind === 'client' ? placement.browserHostClientId : null
            }
            return null
          }
        })
      : null
    const { pairedServerRows } = this.runtime
    this.detachPairedServerRows?.()
    this.detachPairedServerRows = hosts && pairedServerRows ? pairedServerRows.attach(hosts) : null
    this.mobileRelayHostCatalog = hosts
      ? new MobileRelayHostCatalog({
          hosts,
          serverRows: pairedServerRows ?? new OnDemandServerWorktreeRows(hosts),
          hostLabelOverrides: () =>
            getHostDisplayLabelOverrides(this.runtime.requireStore().getSettings()),
          getWorkspaceSession: (hostId) => this.runtime.getWorkspaceSessionForHost(hostId)
        })
      : null
  }

  private listRelayedPhones(): { phoneKey: string; name: string }[] {
    const computerName = this.runtime.readMachineName()
    return (this.deviceRegistry?.listDevices() ?? [])
      .filter(
        // Phones delegated by another desktop remain that desktop's relay responsibility.
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

  /** Persist pending credentials only after the requested transport and E2EE identity are ready. */
  createPairingOffer(args: {
    address?: string | null
    name?: string
    rotate?: boolean
    scope?: DeviceScope
    // Only iroh-mode mobile offers may advertise off-LAN iroh reachability.
    includeIroh?: boolean
    // Persist local-only policy on grants so reconnect cannot expose every interface; other callers default to network reach (STA-2370).
    reach?: RuntimePairingReach
    // Grant administrative permissions only at pairing, never as later device upgrades.
    grants?: readonly RuntimeDeviceGrant[]
    // Desktop UI only; absent keeps headless offers valid until scanned.
    offerTtlMs?: number
  }):
    | PairingOfferUnavailable
    | {
        available: true
        pairingUrl: string
        endpoint: string
        deviceId: string
        webClientUrl: string | null
        offerExpiresAt: number | null
      } {
    if (this.pairingInitializationFailure) {
      return this.pairingInitializationFailure
    }
    const iroh = args.includeIroh ? this.getIrohPairingTarget() : null
    if (args.includeIroh && !iroh) {
      return pairingUnavailable(
        'iroh_unavailable',
        'Iroh pairing is unavailable. Choose another home relay in Mobile settings or inspect the Iroh transport logs.'
      )
    }
    let endpoint: string
    if (iroh) {
      endpoint = `iroh://${iroh.endpointId}`
    } else {
      const rawEndpoint = this.getWebSocketEndpoint()
      if (!rawEndpoint) {
        return pairingUnavailable(
          'websocket_unavailable',
          'WebSocket pairing is unavailable. Inspect preceding runtime errors and choose an unused --port if the listener failed.'
        )
      }
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
    let device: TokenDeviceEntry
    try {
      const reach = args.reach ?? 'network'
      const grants = args.grants ?? []
      const ttl = args.offerTtlMs
      device = args.rotate
        ? this.deviceRegistry.rotatePendingDevice(deviceName, scope, reach, grants, ttl)
        : this.deviceRegistry.getOrCreatePendingDevice(deviceName, scope, reach, grants, ttl)
    } catch (error) {
      console.error('[runtime] Failed to persist pairing credential:', error)
      return pairingUnavailable('device_registry_unavailable', DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE)
    }
    const hostDescriptor = this.hostDescriptor
    const pairingUrl = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint,
      deviceToken: device.token,
      publicKeyB64,
      pairedDeviceId: device.deviceId,
      scope,
      ...(iroh ? { iroh } : {}),
      // Runtime clients pin host identity; mobile does not need these extra QR bytes.
      ...(hostDescriptor && scope === 'runtime' ? { hostDescriptor } : {})
    })
    return {
      available: true,
      pairingUrl,
      endpoint,
      deviceId: device.deviceId,
      webClientUrl:
        this.webClientRoot && scope === 'runtime' ? createWebClientUrl(endpoint, pairingUrl) : null,
      offerExpiresAt: device.offerExpiresAt ?? null
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
