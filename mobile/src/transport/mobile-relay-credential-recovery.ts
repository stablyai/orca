import { MOBILE_RELAY_CLOSE_CODE } from '../../../src/shared/mobile-relay-close-codes'
import type { DeviceResumeConfirmed } from '../../../src/shared/mobile-relay-credential-contract'
import { MobileRelayUpgradeHostRemovedError } from './host-store'
import { persistRelayHost } from './mobile-endpoint-supervisor-support'
import {
  applyResumeConfirmation,
  mobileRelayCredentialNeedsRotation,
  rotateMobileRelayCredential
} from './mobile-relay-credential-rotation'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { MobileRelayDirectUpgradeResult } from './mobile-relay-direct-upgrade'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionLogLevel, ConnectionLogSink, HostProfile } from './types'

export type MobileRelayCredentialRecoveryDependencies = {
  readBundle: (hostId: string) => Promise<MobileRelayCredentialBundle | null>
  writeBundle: (bundle: MobileRelayCredentialBundle) => Promise<void>
  deleteBundle: (hostId: string) => Promise<void>
  reprovisionRelay: (
    client: StableLogicalRpcClient,
    host: HostProfile
  ) => Promise<MobileRelayDirectUpgradeResult | null>
  saveHost: (host: HostProfile) => Promise<void>
  onLog: ConnectionLogSink
  now: () => number
  randomBytes: (length: number) => Uint8Array
}

export type MobileRelayReprovisionOutcome = 'restored' | 'unsupported' | 'deferred'

export class MobileRelayCredentialRecovery {
  host: HostProfile
  bundle: MobileRelayCredentialBundle | null = null
  private repairNeeded = false
  private unavailableLogged = false
  private rotationInFlight = false
  private mutationTail: Promise<void> = Promise.resolve()
  private readonly disabledVersions = new Set<number>()
  private logSequence = 0

  constructor(
    host: HostProfile,
    private readonly dependencies: MobileRelayCredentialRecoveryDependencies
  ) {
    this.host = host
  }

  get needsRepair(): boolean {
    return this.repairNeeded
  }

  get needsAuthenticatedRepair(): boolean {
    return this.repairNeeded || !this.hasUsableCredential()
  }

  async load(): Promise<void> {
    this.bundle = await this.dependencies.readBundle(this.host.id).catch(() => null)
  }

  hasUsableCredential(): boolean {
    return this.usableCredentials().length > 0
  }

  usableCredentials(): Array<{ token: string; version: number }> {
    return [this.bundle?.current, this.bundle?.grace].filter(
      (credential): credential is NonNullable<typeof credential> =>
        Boolean(
          credential &&
          credential.expiresAt > this.dependencies.now() &&
          !this.disabledVersions.has(credential.version)
        )
    )
  }

  markUnavailable(): void {
    this.repairNeeded = true
    if (this.unavailableLogged) {
      return
    }
    this.unavailableLogged = true
    this.emit('warn', 'Relay credential unavailable', 'Will restore on authenticated LAN')
  }

  recordFailure(version: number, error: Error): void {
    if (
      error instanceof RelayOuterError &&
      error.code === MOBILE_RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL
    ) {
      this.disabledVersions.add(version)
      this.repairNeeded = true
      this.emit('error', 'Relay credential rejected', 'Will restore on authenticated LAN')
      return
    }
    this.emit('warn', 'Relay connection failed', relayFailureDetail(error))
  }

  async recordRelayConnected(
    usedCredentialVersion: number,
    confirmation: DeviceResumeConfirmed | null
  ): Promise<void> {
    await this.runCredentialMutation(async () => {
      this.unavailableLogged = false
      if (confirmation && this.bundle) {
        const next = applyResumeConfirmation(this.bundle, usedCredentialVersion, confirmation)
        await this.writeBundle(next)
        this.bundle = next
      }
      this.emit('success', 'Relay connected')
    })
  }

  async rotateIfNeeded(client: StableLogicalRpcClient): Promise<void> {
    if (this.rotationInFlight) {
      return
    }
    this.rotationInFlight = true
    try {
      await this.runCredentialMutation(async () => {
        if (
          !this.bundle ||
          client.getActivePath() === 'relay' ||
          !mobileRelayCredentialNeedsRotation(this.bundle, this.dependencies.now())
        ) {
          return
        }
        try {
          const result = await rotateMobileRelayCredential({
            client,
            bundle: this.bundle,
            writeBundle: (value) => this.writeBundle(value),
            onBundlePersisted: (value) => {
              this.bundle = value
            },
            randomBytes: this.dependencies.randomBytes
          })
          this.bundle = result.bundle
          this.host = await persistRelayHost(this.host, result.relay, this.dependencies.saveHost)
        } catch (error) {
          if (error instanceof MobileRelayUpgradeHostRemovedError) {
            await this.removeDeletedHostBundle()
          }
          // Why: pending material remains durable; the next authenticated direct
          // opportunity must reconcile it before creating another install key.
        }
      })
    } finally {
      this.rotationInFlight = false
    }
  }

  async reprovision(client: StableLogicalRpcClient): Promise<MobileRelayReprovisionOutcome> {
    return this.runCredentialMutation(async () => {
      try {
        const result = await this.dependencies.reprovisionRelay(client, this.host)
        if (!result) {
          return 'unsupported'
        }
        this.host = result.host
        this.bundle = result.bundle
        this.disabledVersions.clear()
        this.repairNeeded = false
        this.unavailableLogged = false
        this.emit('success', 'Relay credential restored')
        return 'restored'
      } catch (error) {
        if (error instanceof MobileRelayUpgradeHostRemovedError) {
          await this.removeDeletedHostBundle()
          return 'unsupported'
        }
        this.emit('warn', 'Relay credential restore deferred', 'Will retry on authenticated LAN')
        return 'deferred'
      }
    })
  }

  private emit(level: ConnectionLogLevel, message: string, detail?: string): void {
    const ts = this.dependencies.now()
    this.dependencies.onLog({
      id: `relay-${ts}-${++this.logSequence}`,
      ts,
      level,
      message,
      ...(detail ? { detail } : {})
    })
  }

  private async writeBundle(bundle: MobileRelayCredentialBundle): Promise<void> {
    try {
      await this.dependencies.writeBundle(bundle)
    } catch (error) {
      if (error instanceof MobileRelayUpgradeHostRemovedError) {
        await this.removeDeletedHostBundle()
      }
      throw error
    }
  }

  private async removeDeletedHostBundle(): Promise<void> {
    this.bundle = null
    await this.dependencies.deleteBundle(this.host.id).catch(() => {})
  }

  private async runCredentialMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let release!: () => void
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

function relayFailureDetail(error: Error): string {
  if (error instanceof RelayOuterError) {
    return `Relay closed (${error.code})`
  }
  return 'Secure Relay handshake did not complete'
}
