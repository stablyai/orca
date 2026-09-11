import type { OrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import type { MobilePairingConnectionContext, OrcaRuntimeRpcServer } from '../runtime-rpc'
import type {
  DeviceCredentialInstalled,
  PairingGetEndpointsParams,
  PairingGetEndpointsResult,
  PairingProvisionRelayParams
} from '../../../shared/mobile-relay-credential-contract'
import type { RelayHostCloseReason } from '../../../shared/relay-host-close-reason'
import { readRelayAuthContext } from './relay-auth-context'
import { RelayAuthCoordinator } from './relay-auth-coordinator'
import { relayOfflineReasonMintFailureCode } from './relay-offline-reason'
import { RelaySessionBroker, type RelayBrokerStatus } from './relay-session-broker'
import type { PairingRelay } from '../../../shared/mobile-relay-pairing-offer'
import type { RelayDeviceBinding, RelayRevokeOutboxItem } from './relay-revoke-outbox'
import { RelayRevokeOutboxFlusher } from './relay-revoke-outbox-flush'
import { deriveRelayHostId } from './relay-http-client'
import { RelayDemandLedger } from './relay-demand-ledger'
import { createRelayRegionPreferenceReader } from './relay-region-preference'
import { pairingAuthorizationForContext } from './relay-pairing-authorization'
import { buildPairingEndpointsResult } from './relay-pairing-endpoints-result'
import type { MobilePairingConnectionMode } from '../../../shared/mobile-pairing-connection-mode'
import { isMobileRelayAllowed } from '../../../shared/mobile-relay-policy'

export { pairingAuthorizationForContext } from './relay-pairing-authorization'

type DesktopRelayServiceOptions = {
  authConfig: OrcaCloudAuthConfig
  userDataPath: string
  appVersion: string
  runtimeRpc: OrcaRuntimeRpcServer
  onStatus: (status: RelayBrokerStatus, cellUrl?: string) => void
  // Live host policy (settings.mobilePairingConnectionMode); read on every
  // demand decision so a LAN pick applies to already-paired devices.
  hostMobilePairingConnectionMode?: () => MobilePairingConnectionMode
}

// Why: a broker that died without arming a retry (sleep past token expiry,
// transient auth read) must not stay dead until the user clicks Retry. The
// cadence is slow because it is a safety net, not the primary retry path.
const RELAY_LIVENESS_INTERVAL_MS = 5 * 60_000

export class DesktopRelayService {
  private readonly coordinator: RelayAuthCoordinator
  private readonly revokeFlusher: RelayRevokeOutboxFlusher
  private readonly runtimeRpc: OrcaRuntimeRpcServer
  private readonly demandLedger: RelayDemandLedger
  private readonly hostMobilePairingConnectionMode?: () => MobilePairingConnectionMode
  private demandExpiryTimer: ReturnType<typeof setTimeout> | null = null
  private livenessTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  // Cleared only by an explicit re-arm (start/authMutated); see fenceAndCloseNow.
  private fenced = false

  constructor(options: DesktopRelayServiceOptions) {
    const keypair = options.runtimeRpc.getE2EEKeypair()
    const mobileSocketWiring = options.runtimeRpc.getMobileSocketWiring()
    if (!keypair || !mobileSocketWiring) {
      throw new Error('mobile_runtime_not_ready')
    }
    this.runtimeRpc = options.runtimeRpc
    const revokeOutbox = options.runtimeRpc.getRelayRevokeOutbox()
    this.revokeFlusher = new RelayRevokeOutboxFlusher({
      outbox: revokeOutbox,
      isHalted: () => this.stopped || this.fenced,
      onDrained: () => this.refreshDemand()
    })
    this.hostMobilePairingConnectionMode = options.hostMobilePairingConnectionMode
    this.demandLedger = new RelayDemandLedger({
      deviceRegistry: options.runtimeRpc.getDeviceRegistry()!,
      revokeOutbox,
      relayHostId: deriveRelayHostId(keypair.publicKey),
      isRelayAllowedForDevice: (deviceId) => this.isRelayAllowedForDevice(deviceId)
    })
    const regionPreference = createRelayRegionPreferenceReader(options)
    this.coordinator = new RelayAuthCoordinator({
      readContext: () => readRelayAuthContext(options.authConfig, options.userDataPath),
      hasDemand: ({ identity }) =>
        this.demandLedger.hasDemand(
          `${identity.userId}\0${identity.profileId}\0${identity.organizationId}`
        ),
      openBroker: async ({ context, isCurrent, refreshAccessToken }) => {
        const broker = await RelaySessionBroker.connect({
          authConfig: options.authConfig,
          accessToken: context.accessToken,
          identity: context.identity,
          keypair,
          appVersion: options.appVersion,
          mobileSocketWiring,
          isCurrent,
          refreshAccessToken,
          resolvePreferredRegion: regionPreference.resolvePreferredRegion,
          onAssignedCellActive: regionPreference.noteAssignedCell,
          onStatus: options.onStatus
        })
        void this.revokeFlusher.flushAll(broker)
        return broker
      },
      onStatus: options.onStatus
    })
  }

  start(): void {
    this.fenced = false
    this.refreshDemand()
  }

  // Safe to call from any wake signal (power resume, network change).
  ensureLive(): void {
    if (!this.stopped && !this.fenced) {
      this.coordinator.ensureLive()
    }
  }

  authMutated(): void {
    this.fenced = false
    this.refreshDemand()
  }

  // The re-armable fence, by design: sign-out and relaunch call this
  // (main-window-core-services.ts onBeforeOrcaProfileSignOut / onBeforeRelaunch)
  // and want the next authMutated to bring Relay back. Quit deliberately does
  // NOT use this — it calls stop(), which is terminal. Keep the two apart.
  fenceAndCloseNow(hostCloseReason?: RelayHostCloseReason): void {
    // Why a latch rather than just clearing the timers: clearing only covered
    // the liveness tick, and everything else outliving the fence lands in
    // refreshDemand and re-arms it — a settling mint's finally, a pending
    // invite-expiry wake, a power-resume ensureLive.
    this.fenced = true
    this.clearTimers()
    this.coordinator.fenceAndCloseNow(hostCloseReason)
  }

  async createPairingRelay(
    relayDeviceId: string
  ): Promise<{ relay: PairingRelay; binding: RelayDeviceBinding }> {
    return await this.withTransientDemand('pairing', relayDeviceId, async () => {
      const broker = await this.requireActiveBroker()
      const relay = await broker.createPairingRelay(relayDeviceId)
      return {
        relay,
        binding: {
          relayHostId: broker.hostId,
          relayDeviceId,
          ownerIdentityKey: broker.ownerIdentityKey,
          inviteExpiresAt: relay.inviteExpiresAt
        }
      }
    })
  }

  onDeviceRevokeQueued(item: RelayRevokeOutboxItem): void {
    this.refreshDemand()
    const broker = this.coordinator.getActiveBroker()
    if (
      broker instanceof RelaySessionBroker &&
      broker.hostId === item.relayHostId &&
      broker.ownerIdentityKey === item.ownerIdentityKey
    ) {
      void this.revokeFlusher.flushItem(broker, item)
    }
  }

  async getEndpoints(
    context: MobilePairingConnectionContext,
    params: PairingGetEndpointsParams
  ): Promise<PairingGetEndpointsResult> {
    this.requireMobileDevice(context.deviceId)
    if (!this.isRelayAllowedForDevice(context.deviceId)) {
      return { v: 1, relay: null }
    }
    return await this.withTransientDemand('endpoints', context.deviceId, async () => {
      const broker = await this.activeBrokerForDemand()
      if (!broker?.endpoint) {
        return { v: 1, relay: null }
      }
      this.assertRelayHost(context, broker)
      return await buildPairingEndpointsResult({
        broker,
        endpoint: broker.endpoint,
        context,
        params
      })
    })
  }

  async provisionRelay(
    context: MobilePairingConnectionContext,
    params: PairingProvisionRelayParams
  ): Promise<DeviceCredentialInstalled> {
    this.requireMobileDevice(context.deviceId)
    if (!this.isRelayAllowedForDevice(context.deviceId)) {
      throw new Error('relay_disabled_for_device')
    }
    return await this.withTransientDemand('provision', context.deviceId, async () => {
      const broker = await this.requireActiveBroker()
      if (!broker.endpoint) {
        throw new Error('relay_control_not_active')
      }
      this.assertRelayHost(context, broker)
      const authorization = pairingAuthorizationForContext(context, broker.hostId)
      if (!authorization) {
        // Why: a resume splice proves renewal through confirmation; it cannot be
        // repurposed as either of the two initial-install authorization modes.
        throw new Error('relay_provision_authorization_unavailable')
      }
      if (
        !this.runtimeRpc.setMobileRelayBinding(context.deviceId, {
          relayHostId: broker.hostId,
          relayDeviceId: context.deviceId,
          ownerIdentityKey: broker.ownerIdentityKey
        })
      ) {
        throw new Error('mobile_device_not_found')
      }
      this.refreshDemand()
      return await broker.installCredential(context.deviceId, params, authorization)
    })
  }

  demandStateChanged(): void {
    this.refreshDemand()
  }

  // Wake signal for a host connection-mode change; the decision is the pull in
  // isRelayAllowedForDevice. Skips the pairing-churn linger: a deliberate LAN
  // pick that kept Relay open for ten more minutes would look like #18211.
  pairingPolicyChanged(): void {
    this.refreshDemand({ skipLinger: true })
  }

  // Terminal: no door re-arms this. Quit calls it (main-process-quit.ts
  // before-quit). The re-armable counterpart is fenceAndCloseNow, which quit
  // must not use — a settling mint or an invite expiry re-arms that one.
  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.coordinator.stop()
  }

  private clearTimers(): void {
    if (this.demandExpiryTimer) {
      clearTimeout(this.demandExpiryTimer)
      this.demandExpiryTimer = null
    }
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer)
      this.livenessTimer = null
    }
  }

  private requireMobileDevice(deviceId: string): void {
    if (this.runtimeRpc.getDeviceRegistry()?.getDevice(deviceId)?.scope !== 'mobile') {
      throw new Error('mobile_device_not_found')
    }
  }

  private assertRelayHost(
    context: MobilePairingConnectionContext,
    broker: RelaySessionBroker
  ): void {
    if (
      context.transport.transport === 'relay' &&
      context.transport.relayHostId !== broker.hostId
    ) {
      throw new Error('stale_relay_connection')
    }
  }

  // Restrictive-only: the host setting withdraws Relay from an `automatic`
  // device, never grants it to a `local-only` one.
  private isRelayAllowedForDevice(deviceId: string): boolean {
    return isMobileRelayAllowed({
      hostConnectionMode: this.hostMobilePairingConnectionMode?.() ?? 'automatic',
      deviceConnectionMode:
        this.runtimeRpc.getDeviceRegistry()?.getMobilePairingConnectionMode(deviceId) ?? null
    })
  }

  // Why the gate lives here: every path that can grant Relay — including
  // createPairingRelay, which had no per-device check — funnels through it.
  private async withTransientDemand<T>(
    kind: 'pairing' | 'endpoints' | 'provision',
    deviceId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    if (!this.isRelayAllowedForDevice(deviceId)) {
      throw new Error('relay_disabled_for_device')
    }
    const release = this.demandLedger.acquireTransient(`${kind}:${deviceId}`, deviceId)
    this.refreshDemand()
    try {
      return await operation()
    } catch (error) {
      // Why re-ask instead of trusting the thrown code: a flip lands mid-operation, and
      // `hasDemand` filters this ref's own demand through the live policy, so the coordinator
      // reaches `standby` and clears the offline reason. The wait then ends with no cause at all
      // — the generic `relay_control_not_active` — when the flip is exactly the cause.
      if (!this.isRelayAllowedForDevice(deviceId)) {
        throw new Error('relay_disabled_for_device')
      }
      throw error
    } finally {
      release()
      this.refreshDemand()
    }
  }

  private async activeBrokerForDemand(): Promise<RelaySessionBroker | null> {
    const broker = this.coordinator.getLiveBroker() ?? (await this.coordinator.waitForLiveBroker())
    return broker instanceof RelaySessionBroker ? broker : null
  }

  private async requireActiveBroker(): Promise<RelaySessionBroker> {
    const result = await this.coordinator.waitForLiveBrokerResult()
    if (!result.broker) {
      throw new Error(relayOfflineReasonMintFailureCode(result.offlineReason))
    }
    if (!(result.broker instanceof RelaySessionBroker)) {
      throw new Error('relay_control_not_active')
    }
    return result.broker
  }

  private refreshDemand(options?: { skipLinger?: boolean }): void {
    if (this.stopped || this.fenced) {
      return
    }
    if (!this.livenessTimer) {
      this.livenessTimer = setInterval(() => this.ensureLive(), RELAY_LIVENESS_INTERVAL_MS)
    }
    if (this.demandExpiryTimer) {
      clearTimeout(this.demandExpiryTimer)
      this.demandExpiryTimer = null
    }
    this.coordinator.reconcile(options)
    const expiresAt = this.demandLedger.nextPendingExpiry()
    if (expiresAt !== null) {
      // Why: an unscanned QR must stop holding a standing control when its
      // server invite expires, even if no renderer survives to report closure.
      this.demandExpiryTimer = setTimeout(
        () => this.refreshDemand(),
        Math.max(1, expiresAt - Date.now() + 1)
      )
    }
  }
}
