import type { OrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import type { MobilePairingConnectionContext, OrcaRuntimeRpcServer } from '../runtime-rpc'
import type {
  DeviceCredentialInstalled,
  PairingGetEndpointsParams,
  PairingGetEndpointsResult,
  PairingProvisionRelayParams
} from '../../../shared/mobile-relay-credential-contract'
import { readRelayAuthContext } from './relay-auth-context'
import { RelayAuthCoordinator } from './relay-auth-coordinator'
import { RelaySessionBroker, type RelayBrokerStatus } from './relay-session-broker'
import type { PairingRelay } from '../../../shared/mobile-relay-pairing-offer'
import type {
  RelayRevokeOutbox,
  RelayDeviceBinding,
  RelayRevokeOutboxItem
} from './relay-revoke-outbox'
import type { DeviceCredentialInstallAuthorization } from './relay-control-requests'
import { deriveRelayHostId } from './relay-http-client'
import { RelayDemandLedger } from './relay-demand-ledger'

type DesktopRelayServiceOptions = {
  authConfig: OrcaCloudAuthConfig
  userDataPath: string
  appVersion: string
  runtimeRpc: OrcaRuntimeRpcServer
  onStatus: (status: RelayBrokerStatus) => void
}

export function pairingAuthorizationForContext(
  context: MobilePairingConnectionContext,
  relayHostId: string
): DeviceCredentialInstallAuthorization | null {
  if (context.transport.transport === 'direct') {
    return { mode: 'authenticated-direct', directAuthId: context.connectionId }
  }
  if (context.transport.relayHostId !== relayHostId) {
    throw new Error('stale_relay_connection')
  }
  return context.transport.credentialKind === 'invite'
    ? { mode: 'relay-basis', basisConnId: context.transport.basisConnId }
    : null
}

export class DesktopRelayService {
  private readonly coordinator: RelayAuthCoordinator
  private readonly revokeOutbox: RelayRevokeOutbox
  private readonly runtimeRpc: OrcaRuntimeRpcServer
  private readonly demandLedger: RelayDemandLedger
  private demandExpiryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(options: DesktopRelayServiceOptions) {
    const keypair = options.runtimeRpc.getE2EEKeypair()
    const mobileSocketWiring = options.runtimeRpc.getMobileSocketWiring()
    if (!keypair || !mobileSocketWiring) {
      throw new Error('mobile_runtime_not_ready')
    }
    this.runtimeRpc = options.runtimeRpc
    this.revokeOutbox = options.runtimeRpc.getRelayRevokeOutbox()
    this.demandLedger = new RelayDemandLedger({
      deviceRegistry: options.runtimeRpc.getDeviceRegistry()!,
      revokeOutbox: this.revokeOutbox,
      relayHostId: deriveRelayHostId(keypair.publicKey)
    })
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
          onStatus: options.onStatus
        })
        void this.flushRevokeOutbox(broker)
        return broker
      },
      onStatus: options.onStatus
    })
  }

  start(): void {
    this.refreshDemand()
  }

  authMutated(): void {
    this.refreshDemand()
  }

  fenceAndCloseNow(): void {
    this.coordinator.fenceAndCloseNow()
  }

  async createPairingRelay(
    relayDeviceId: string
  ): Promise<{ relay: PairingRelay; binding: RelayDeviceBinding }> {
    return await this.withTransientDemand(`pairing:${relayDeviceId}`, async () => {
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
      void this.flushRevoke(broker, item)
    }
  }

  async getEndpoints(
    context: MobilePairingConnectionContext,
    params: PairingGetEndpointsParams
  ): Promise<PairingGetEndpointsResult> {
    this.requireMobileDevice(context.deviceId)
    if (
      this.runtimeRpc.getDeviceRegistry()?.getMobilePairingConnectionMode(context.deviceId) ===
      'local-only'
    ) {
      return { v: 1, relay: null }
    }
    return await this.withTransientDemand(`endpoints:${context.deviceId}`, async () => {
      const broker = await this.activeBrokerForDemand()
      if (!broker?.endpoint) {
        return { v: 1, relay: null }
      }
      this.assertRelayHost(context, broker)
      const result: PairingGetEndpointsResult = { v: 1, relay: broker.endpoint }
      if (params.installReqId) {
        result.installStatus = await broker.credentialInstallStatus(
          context.deviceId,
          params.installReqId
        )
      }
      if (params.resumeConfirmReqId) {
        if (
          context.transport.transport !== 'relay' ||
          context.transport.credentialKind !== 'resume'
        ) {
          throw new Error('resume_confirmation_unavailable')
        }
        result.resumeConfirmation = await broker.confirmResume(
          context.transport.basisConnId,
          params.resumeConfirmReqId
        )
      }
      return result
    })
  }

  async provisionRelay(
    context: MobilePairingConnectionContext,
    params: PairingProvisionRelayParams
  ): Promise<DeviceCredentialInstalled> {
    this.requireMobileDevice(context.deviceId)
    if (
      this.runtimeRpc.getDeviceRegistry()?.getMobilePairingConnectionMode(context.deviceId) ===
      'local-only'
    ) {
      throw new Error('relay_disabled_for_device')
    }
    return await this.withTransientDemand(`provision:${context.deviceId}`, async () => {
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

  stop(): void {
    this.stopped = true
    if (this.demandExpiryTimer) {
      clearTimeout(this.demandExpiryTimer)
      this.demandExpiryTimer = null
    }
    this.coordinator.stop()
  }

  private async flushRevokeOutbox(broker: RelaySessionBroker): Promise<void> {
    for (const item of this.revokeOutbox.pendingFor(broker.ownerIdentityKey, broker.hostId)) {
      await this.flushRevoke(broker, item)
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

  private async flushRevoke(
    broker: RelaySessionBroker,
    item: RelayRevokeOutboxItem
  ): Promise<void> {
    try {
      await broker.revokeDevice(item.relayDeviceId, item.reqId)
      this.revokeOutbox.remove(item.reqId)
      this.refreshDemand()
    } catch {
      // Why: the durable item is the source of truth; reconnecting the same
      // account/control retries this stable reqId without delaying local revoke.
    }
  }

  private async withTransientDemand<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const release = this.demandLedger.acquireTransient(key)
    this.refreshDemand()
    try {
      return await operation()
    } finally {
      release()
      this.refreshDemand()
    }
  }

  private async activeBrokerForDemand(): Promise<RelaySessionBroker | null> {
    const broker =
      this.coordinator.getActiveBroker() ?? (await this.coordinator.waitForActiveBroker())
    return broker instanceof RelaySessionBroker ? broker : null
  }

  private async requireActiveBroker(): Promise<RelaySessionBroker> {
    const broker = await this.activeBrokerForDemand()
    if (!broker) {
      throw new Error('relay_control_not_active')
    }
    return broker
  }

  private refreshDemand(): void {
    if (this.stopped) {
      return
    }
    if (this.demandExpiryTimer) {
      clearTimeout(this.demandExpiryTimer)
      this.demandExpiryTimer = null
    }
    this.coordinator.reconcile()
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
