import type { PairingRelay } from '../../../shared/mobile-relay-pairing-offer'
import type {
  DeviceCredentialInstalled,
  DeviceCredentialInstallStatusResult,
  DeviceResumeConfirmed,
  MobileRelayEndpoint,
  PairingProvisionRelayParams
} from '../../../shared/mobile-relay-credential-contract'
import type { DeviceCredentialInstallAuthorization } from './relay-control-requests'
import {
  deriveRelayHostId,
  exchangeRelayAuthorization,
  requestRelayAssignment,
  type RelayAuthorization,
  type RelayAssignment
} from './relay-http-client'
import { RelayOriginPool } from './relay-origin-pool'
import type { RelayBrokerStatus, RelaySessionBrokerOptions } from './relay-session-broker-contract'

export type { RelayBrokerStatus } from './relay-session-broker-contract'

export class StaleRelayBrokerError extends Error {
  constructor() {
    super('stale_relay_broker')
  }
}

export class RelaySessionBroker {
  private readonly options: RelaySessionBrokerOptions
  private readonly relayHostId: string
  private readonly originPool: RelayOriginPool
  private authorization: RelayAuthorization | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  private constructor(options: RelaySessionBrokerOptions) {
    this.options = options
    this.relayHostId = deriveRelayHostId(options.keypair.publicKey)
    this.originPool = new RelayOriginPool({
      directorUrl: options.authConfig.relayDirectorUrl,
      relayHostId: this.relayHostId,
      identity: options.identity,
      keypair: options.keypair,
      appVersion: options.appVersion,
      mobileSocketWiring: options.mobileSocketWiring,
      isCurrent: () => this.isCurrent(),
      onStatus: (status) => this.publishStatus(status),
      fetch: options.fetch,
      createControlSocket: options.createControlSocket,
      createDataSocket: options.createDataSocket,
      random: options.random,
      now: options.now
    })
  }

  static async connect(options: RelaySessionBrokerOptions): Promise<RelaySessionBroker> {
    const broker = new RelaySessionBroker(options)
    try {
      await broker.open(options.accessToken)
      return broker
    } catch (error) {
      broker.closeNow()
      throw error
    }
  }

  get hostId(): string {
    return this.relayHostId
  }

  get currentAssignment(): RelayAssignment | null {
    return this.originPool.activeAssignment
  }

  get ownerIdentityKey(): string {
    const identity = this.options.identity
    return `${identity.userId}\0${identity.profileId}\0${identity.organizationId}`
  }

  get endpoint(): MobileRelayEndpoint | null {
    const assignment = this.originPool.activeAssignment
    if (!assignment) {
      return null
    }
    return {
      v: 1,
      directorUrl: this.options.authConfig.relayDirectorUrl,
      cellUrl: assignment.cellUrl,
      assignmentEpoch: assignment.assignmentEpoch,
      relayHostId: this.relayHostId,
      e2eeFraming: 2
    }
  }

  createInvite(relayDeviceId: string) {
    const control = this.originPool.activeControl
    if (!control) {
      return Promise.reject(new Error('relay_control_not_active'))
    }
    return control.createInvite(relayDeviceId)
  }

  async createPairingRelay(relayDeviceId: string): Promise<PairingRelay> {
    const assignment = this.originPool.activeAssignment
    const control = this.originPool.activeControl
    if (!assignment || !control) {
      throw new Error('relay_control_not_active')
    }
    const invite = await control.createInvite(relayDeviceId)
    this.assertCurrent()
    return {
      v: 1,
      directorUrl: this.options.authConfig.relayDirectorUrl,
      cellUrl: assignment.cellUrl,
      assignmentEpoch: assignment.assignmentEpoch,
      relayHostId: this.relayHostId,
      inviteToken: invite.inviteToken,
      inviteExpiresAt: invite.expiresAt,
      e2eeFraming: 2
    }
  }

  revokeDevice(relayDeviceId: string, reqId?: string): Promise<void> {
    const control = this.originPool.activeControl
    if (!control) {
      return Promise.reject(new Error('relay_control_not_active'))
    }
    return control.revokeDevice(relayDeviceId, reqId)
  }

  async installCredential(
    relayDeviceId: string,
    params: PairingProvisionRelayParams,
    authorization: DeviceCredentialInstallAuthorization
  ): Promise<DeviceCredentialInstalled> {
    const control =
      authorization.mode === 'relay-basis'
        ? this.originPool.controlForBasis(authorization.basisConnId)
        : this.originPool.activeControl
    if (!control) {
      throw new Error('relay_control_not_active')
    }
    const message = await control.installCredential({
      relayDeviceId,
      authorization,
      ...params
    })
    this.assertCurrent()
    const { type: _type, ...result } = message
    return result
  }

  async credentialInstallStatus(
    relayDeviceId: string,
    reqId: string
  ): Promise<DeviceCredentialInstallStatusResult> {
    const control = this.originPool.activeControl
    if (!control) {
      throw new Error('relay_control_not_active')
    }
    const message = await control.credentialInstallStatus(relayDeviceId, reqId)
    this.assertCurrent()
    const { type: _type, ...result } = message
    return result
  }

  async confirmResume(basisConnId: string, reqId: string): Promise<DeviceResumeConfirmed> {
    const control = this.originPool.controlForBasis(basisConnId)
    if (!control) {
      throw new Error('relay_basis_origin_not_found')
    }
    const message = await control.confirmResume(basisConnId, reqId)
    this.assertCurrent()
    const { type: _type, ...result } = message
    return result
  }

  closeNow(): void {
    if (this.closed) {
      return
    }
    const publishOffline = this.options.isCurrent()
    this.closed = true
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
    this.originPool.closeNow()
    if (publishOffline) {
      this.options.onStatus('offline')
    }
  }

  private async open(accessToken: string): Promise<void> {
    this.publishStatus('connecting')
    const authorization = await exchangeRelayAuthorization({
      endpoint: this.options.authConfig.relayTokenEndpoint,
      accessToken,
      keypair: this.options.keypair,
      fetch: this.options.fetch
    })
    this.assertCurrent()
    const assignment = await requestRelayAssignment({
      directorUrl: this.options.authConfig.relayDirectorUrl,
      relayToken: authorization.relayToken,
      relayHostId: this.relayHostId,
      fetch: this.options.fetch
    })
    this.assertCurrent()
    try {
      await this.originPool.openInitial(assignment, authorization.relayToken)
    } catch (error) {
      if (!this.isCurrent()) {
        throw new StaleRelayBrokerError()
      }
      throw error
    }
    this.assertCurrent()
    this.authorization = authorization
    this.publishStatus('registered')
    this.scheduleRefresh()
  }

  private scheduleRefresh(): void {
    const authorization = this.authorization
    if (!authorization || this.closed) {
      return
    }
    const now = (this.options.now ?? Date.now)()
    const random = this.options.random ?? Math.random
    const earlyMs = 60_000 + Math.floor(random() * 60_001)
    const delay = Math.max(0, authorization.expiresAt - earlyMs - now)
    this.refreshTimer = setTimeout(() => void this.refreshAuthorization(), delay)
  }

  private async refreshAuthorization(): Promise<void> {
    this.refreshTimer = null
    try {
      const accessToken = await this.options.refreshAccessToken()
      this.assertCurrent()
      if (!accessToken) {
        this.closeNow()
        return
      }
      const authorization = await exchangeRelayAuthorization({
        endpoint: this.options.authConfig.relayTokenEndpoint,
        accessToken,
        keypair: this.options.keypair,
        fetch: this.options.fetch
      })
      this.assertCurrent()
      this.originPool.refreshAuthorization(authorization.relayToken)
      this.authorization = authorization
      this.scheduleRefresh()
    } catch {
      const expiry = this.authorization?.expiresAt ?? 0
      const now = (this.options.now ?? Date.now)()
      if (!this.closed && this.options.isCurrent() && now <= expiry + 60_000) {
        const random = this.options.random ?? Math.random
        this.refreshTimer = setTimeout(
          () => void this.refreshAuthorization(),
          5_000 + Math.floor(random() * 10_001)
        )
        return
      }
      this.closeNow()
    }
  }

  private assertCurrent(): void {
    if (!this.isCurrent()) {
      throw new StaleRelayBrokerError()
    }
  }

  private isCurrent(): boolean {
    return !this.closed && this.options.isCurrent()
  }

  private publishStatus(status: RelayBrokerStatus): void {
    if (this.isCurrent()) {
      this.options.onStatus(status)
    }
  }
}
