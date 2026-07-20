import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import { openAuthenticatedDirectEndpoint } from './mobile-direct-endpoint-probe'
import { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import {
  encodeBase64Url,
  isDirectorResolutionFailure,
  persistRelayHost,
  toError
} from './mobile-endpoint-supervisor-support'
import {
  applyResumeConfirmation,
  mobileRelayCredentialNeedsRotation,
  rotateMobileRelayCredential
} from './mobile-relay-credential-rotation'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { MobileRelayRpcSession } from './mobile-relay-rpc-session'
import { resolveMobileRelayEndpoint } from './mobile-relay-resume-director'
import type { RpcClient } from './rpc-client'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { HostProfile } from './types'

const DIRECT_PROBE_INTERVAL_MS = 15_000
const DIRECT_OBSERVATION_MS = 30_000
const MINIMUM_DWELL_MS = 60_000
const FAILURE_COOLDOWN_MS = 60_000
const LEASE_ROTATION_MARGIN_MS = 30_000

export type MobileEndpointSupervisorDependencies = {
  openDirect: (endpoint: string) => RpcClient
  openRelay: (
    relay: MobileRelayEndpoint,
    credential: { token: string; version: number },
    confirmReqId: string
  ) => MobileRelayRpcSession
  resolveRelay: typeof resolveMobileRelayEndpoint
  readBundle: (hostId: string) => Promise<MobileRelayCredentialBundle | null>
  writeBundle: (bundle: MobileRelayCredentialBundle) => Promise<void>
  saveHost: (host: HostProfile) => Promise<void>
  now: () => number
  randomBytes: (length: number) => Uint8Array
  setTimer: typeof setTimeout
  clearTimer: typeof clearTimeout
}

export class MobileEndpointSupervisor {
  private host: HostProfile
  private bundle: MobileRelayCredentialBundle | null = null
  private stopped = false
  private foreground = true
  private operationInFlight = false
  private credentialRotationInFlight = false
  private relayRotationPending = false
  private probeTimer: ReturnType<typeof setTimeout> | null = null
  private leaseTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribeState: (() => void) | null = null
  private readonly hysteresis: MobileEndpointHysteresis

  constructor(
    private readonly logical: StableLogicalRpcClient,
    host: HostProfile,
    private readonly dependencies: MobileEndpointSupervisorDependencies
  ) {
    this.host = host
    this.hysteresis = new MobileEndpointHysteresis(dependencies.now(), {
      directSuccessesRequired: 3,
      directObservationMs: DIRECT_OBSERVATION_MS,
      failureCooldownMs: FAILURE_COOLDOWN_MS,
      minimumDwellMs: MINIMUM_DWELL_MS
    })
  }

  async start(): Promise<void> {
    this.bundle = await this.dependencies.readBundle(this.host.id).catch(() => null)
    if (this.stopped || !this.bundle || !this.host.relay) {
      return
    }
    this.unsubscribeState = this.logical.onStateChange((state) => {
      if (state === 'connected') {
        if (this.logical.getActivePath() !== 'relay') {
          void this.rotateCredentialIfNeeded()
        }
        this.scheduleDirectProbe()
      } else if (state === 'reconnecting' || state === 'disconnected' || state === 'auth-failed') {
        // Why: the direct client enters reconnecting after its first failed
        // dial and may never publish disconnected while its retry loop lives.
        void this.recoverRelay()
      }
    })
    const initialState = this.logical.getState()
    if (
      initialState === 'reconnecting' ||
      initialState === 'disconnected' ||
      initialState === 'auth-failed'
    ) {
      // Why: the first direct dial can fail while encrypted relay credentials
      // are still loading, before the supervisor subscribes to state changes.
      await this.recoverRelay()
    } else {
      this.scheduleDirectProbe()
    }
  }

  setForeground(foreground: boolean): void {
    this.foreground = foreground
    if (foreground) {
      void this.recoverRelay(this.relayRotationPending)
      this.scheduleDirectProbe(0)
    } else {
      if (this.logical.getActivePath() === 'relay') {
        // Why: background phones must not hold billed relay data splices; the
        // stable client keeps subscriptions for authenticated foreground replay.
        this.logical.suspendActiveSession()
      }
      if (this.probeTimer) {
        this.dependencies.clearTimer(this.probeTimer)
        this.probeTimer = null
      }
    }
  }

  stop(): void {
    this.stopped = true
    this.unsubscribeState?.()
    this.unsubscribeState = null
    if (this.probeTimer) {
      this.dependencies.clearTimer(this.probeTimer)
      this.probeTimer = null
    }
    this.clearLeaseTimer()
  }

  private async recoverRelay(forceReplacement = false): Promise<void> {
    if (
      this.stopped ||
      !this.foreground ||
      this.operationInFlight ||
      !this.bundle ||
      !this.host.relay ||
      (!forceReplacement && this.logical.getState() === 'connected')
    ) {
      return
    }
    this.operationInFlight = true
    try {
      const credentials = [this.bundle.current, this.bundle.grace].filter(
        (credential): credential is NonNullable<typeof credential> =>
          Boolean(credential && credential.expiresAt > this.dependencies.now())
      )
      for (const credential of credentials) {
        if (await this.tryRelayCredential(credential)) {
          return
        }
      }
    } finally {
      this.operationInFlight = false
      if (forceReplacement && this.relayRotationPending && !this.stopped && !this.leaseTimer) {
        this.leaseTimer = this.dependencies.setTimer(() => {
          this.leaseTimer = null
          void this.recoverRelay(true)
        }, 5000)
      }
    }
  }

  private async tryRelayCredential(credential: {
    token: string
    version: number
  }): Promise<boolean> {
    const first = await this.openAndMigrateRelay(credential)
    if (first.ok) {
      return true
    }
    if (!isDirectorResolutionFailure(first.error) || !this.host.relay) {
      return false
    }
    try {
      const resolved = await this.dependencies.resolveRelay({
        relay: this.host.relay,
        resumeToken: credential.token
      })
      this.host = await persistRelayHost(this.host, resolved, this.dependencies.saveHost)
      return (await this.openAndMigrateRelay(credential)).ok
    } catch {
      return false
    }
  }

  private async openAndMigrateRelay(credential: {
    token: string
    version: number
  }): Promise<{ ok: true } | { ok: false; error: Error }> {
    if (!this.host.relay || !this.bundle) {
      return { ok: false, error: new Error('relay state missing') }
    }
    const session = this.dependencies.openRelay(
      this.host.relay,
      credential,
      `confirm-${encodeBase64Url(this.dependencies.randomBytes(16))}`
    )
    try {
      await this.logical.migrateTo(session, 'relay')
      if (!this.foreground) {
        this.logical.suspendActiveSession()
      }
      this.relayRotationPending = false
      this.hysteresis.recordMigration(this.dependencies.now())
      const confirmation = session.getResumeConfirmation()
      if (confirmation) {
        this.bundle = applyResumeConfirmation(this.bundle, credential.version, confirmation)
        await this.dependencies.writeBundle(this.bundle)
      }
      this.scheduleLeaseRotation(session)
      this.scheduleDirectProbe()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: session.getFailure() ?? toError(error) }
    }
  }

  private scheduleDirectProbe(delayMs = DIRECT_PROBE_INTERVAL_MS): void {
    if (
      this.stopped ||
      !this.foreground ||
      this.logical.getActivePath() !== 'relay' ||
      this.probeTimer
    ) {
      return
    }
    this.probeTimer = this.dependencies.setTimer(() => {
      this.probeTimer = null
      void this.probeDirect()
    }, delayMs)
  }

  private async probeDirect(): Promise<void> {
    if (
      this.stopped ||
      !this.foreground ||
      this.operationInFlight ||
      !this.hysteresis.canProbe(this.dependencies.now())
    ) {
      this.scheduleDirectProbe()
      return
    }
    this.operationInFlight = true
    let successful: Awaited<ReturnType<typeof openAuthenticatedDirectEndpoint>> = null
    try {
      const openDirect = this.dependencies.openDirect
      successful = await openAuthenticatedDirectEndpoint(this.host, openDirect, 12_000)
      if (!successful) {
        this.hysteresis.recordDirectFailure(this.dependencies.now())
        return
      }
      if (!this.hysteresis.recordDirectSuccess(this.dependencies.now())) {
        successful.client.close()
        return
      }
      await this.logical.migrateTo(successful.client, successful.path)
      successful = null
      this.hysteresis.recordMigration(this.dependencies.now())
      this.clearLeaseTimer()
      this.relayRotationPending = false
      await this.rotateCredentialIfNeeded()
    } finally {
      successful?.client.close()
      this.operationInFlight = false
      if (this.relayRotationPending) {
        void this.recoverRelay(true)
      }
      this.scheduleDirectProbe()
    }
  }

  private async rotateCredentialIfNeeded(): Promise<void> {
    if (
      this.stopped ||
      this.credentialRotationInFlight ||
      !this.bundle ||
      this.logical.getActivePath() === 'relay' ||
      !mobileRelayCredentialNeedsRotation(this.bundle, this.dependencies.now())
    ) {
      return
    }
    this.credentialRotationInFlight = true
    try {
      const result = await rotateMobileRelayCredential({
        client: this.logical,
        bundle: this.bundle,
        writeBundle: this.dependencies.writeBundle,
        randomBytes: this.dependencies.randomBytes
      })
      this.bundle = result.bundle
      this.host = await persistRelayHost(this.host, result.relay, this.dependencies.saveHost)
    } catch {
      // Why: pending material remains durable; the next authenticated direct
      // opportunity must reconcile it before creating another install key.
    } finally {
      this.credentialRotationInFlight = false
    }
  }

  private scheduleLeaseRotation(session: MobileRelayRpcSession): void {
    this.clearLeaseTimer()
    const deadline = session.getLeaseExpiresAt()
    if (!deadline) {
      return
    }
    const delay = Math.max(1000, deadline - this.dependencies.now() - LEASE_ROTATION_MARGIN_MS)
    this.leaseTimer = this.dependencies.setTimer(() => {
      this.leaseTimer = null
      this.relayRotationPending = true
      void this.recoverRelay(true)
    }, delay)
  }

  private clearLeaseTimer(): void {
    if (this.leaseTimer) {
      this.dependencies.clearTimer(this.leaseTimer)
      this.leaseTimer = null
    }
  }
}
