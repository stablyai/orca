import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import { openAuthenticatedDirectEndpoint } from './mobile-direct-endpoint-probe'
import { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import { MobileEndpointSupervisorTimers } from './mobile-endpoint-supervisor-timers'
import {
  isDirectorResolutionFailure,
  withEndpointRouteDeadline
} from './mobile-endpoint-supervisor-support'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { MobileRelayCredentialRotationController } from './mobile-relay-credential-rotation-controller'
import type { MobileRelayRpcSession } from './mobile-relay-rpc-session'
import { MobileRelayHostPersistence } from './mobile-relay-host-persistence'
import type { resolveMobileRelayEndpoint } from './mobile-relay-resume-director'
import {
  isFinalRelayFailure,
  openMobileRelayRoute,
  releaseInactiveMobileRelayRouteResult
} from './mobile-relay-route-connection'
import type { RpcClient } from './rpc-client'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { HostProfile } from './types'

const DIRECT_PROBE_INTERVAL_MS = 15_000
const DIRECT_OBSERVATION_MS = 30_000
const MINIMUM_DWELL_MS = 60_000

export type MobileRelayFallbackControllerDependencies = {
  openDirect: (endpoint: string) => RpcClient
  openRelay: (
    relay: MobileRelayEndpoint,
    credential: { token: string; version: number },
    confirmReqId: string
  ) => MobileRelayRpcSession
  resolveRelay: typeof resolveMobileRelayEndpoint
  readBundle: (hostId: string) => Promise<MobileRelayCredentialBundle | null>
  writeBundle: (bundle: MobileRelayCredentialBundle) => Promise<void>
  deleteBundle: (hostId: string) => Promise<void>
  saveHost: (host: HostProfile) => Promise<void>
  now: () => number
  randomBytes: (length: number) => Uint8Array
  setTimer: typeof setTimeout
  clearTimer: typeof clearTimeout
}

export class MobileRelayFallbackController {
  private host: HostProfile
  private bundle: MobileRelayCredentialBundle | null = null
  private stopped = false
  private foreground = true
  private operationInFlight = false
  private relayRotationPending = false
  private probeTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribeState: (() => void) | null = null
  private readonly hysteresis: MobileEndpointHysteresis
  private readonly timers: MobileEndpointSupervisorTimers
  private readonly relayPersistence: MobileRelayHostPersistence
  private readonly credentialRotation: MobileRelayCredentialRotationController

  constructor(
    private readonly logical: StableLogicalRpcClient,
    host: HostProfile,
    private readonly dependencies: MobileRelayFallbackControllerDependencies
  ) {
    this.host = host
    this.hysteresis = new MobileEndpointHysteresis(dependencies.now(), {
      directSuccessesRequired: 3,
      directObservationMs: DIRECT_OBSERVATION_MS,
      failureCooldownMs: 60_000,
      minimumDwellMs: MINIMUM_DWELL_MS
    })
    this.timers = new MobileEndpointSupervisorTimers(dependencies.setTimer, dependencies.clearTimer)
    this.relayPersistence = new MobileRelayHostPersistence(
      dependencies.writeBundle,
      dependencies.deleteBundle,
      dependencies.saveHost,
      dependencies.randomBytes,
      dependencies.setTimer,
      dependencies.clearTimer
    )
    this.credentialRotation = new MobileRelayCredentialRotationController(
      logical,
      this.relayPersistence,
      () => this.host,
      () => this.bundle,
      (result) => {
        this.host = result.host
        this.bundle = result.bundle
      },
      () => !this.stopped && this.foreground,
      dependencies.now
    )
  }

  async start(): Promise<void> {
    this.bundle = await this.dependencies.readBundle(this.host.id).catch(() => null)
    if (this.stopped || !this.bundle || !this.host.relay) {
      return
    }
    this.unsubscribeState = this.logical.onStateChange((state) => {
      if (state === 'connected') {
        if (this.logical.getActivePath() !== 'relay') {
          void this.credentialRotation.rotateIfNeeded()
        }
        this.scheduleDirectProbe()
      } else if (state === 'reconnecting' || state === 'disconnected') {
        // Why: the direct client enters reconnecting after its first failed
        // dial and may never publish disconnected while its retry loop lives.
        void this.recoverRelay()
      }
    })
    const initialState = this.logical.getState()
    if (initialState === 'reconnecting' || initialState === 'disconnected') {
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
    this.timers.clearAll()
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
      const retryPending = forceReplacement && this.relayRotationPending
      if (retryPending && !this.stopped && !this.timers.hasScheduled()) {
        this.timers.scheduleRetry(5000, () => {
          void this.recoverRelay(true)
        })
      }
    }
  }

  private async tryRelayCredential(credential: {
    token: string
    version: number
  }): Promise<boolean> {
    const first = await this.openAndMigrateRelay(credential)
    if (first.ok || isFinalRelayFailure(first, !this.stopped && this.foreground)) {
      return true
    }
    if (!isDirectorResolutionFailure(first.error) || !this.host.relay) {
      return false
    }
    try {
      const resolved = await withEndpointRouteDeadline({
        promise: this.dependencies.resolveRelay({
          relay: this.host.relay,
          resumeToken: credential.token
        }),
        timeoutMs: 12_000,
        setTimer: this.dependencies.setTimer,
        clearTimer: this.dependencies.clearTimer
      })
      if (this.stopped || !this.foreground) {
        return true
      }
      this.host = await this.relayPersistence.persist(this.host, resolved, 12_000)
      const retried = await this.openAndMigrateRelay(credential)
      return retried.ok || isFinalRelayFailure(retried, !this.stopped && this.foreground)
    } catch {
      return false
    }
  }

  private async openAndMigrateRelay(credential: {
    token: string
    version: number
  }): ReturnType<typeof openMobileRelayRoute> {
    if (!this.host.relay || !this.bundle) {
      return {
        ok: false as const,
        error: new Error('relay state missing'),
        authenticationFailed: false
      }
    }
    const result = await openMobileRelayRoute({
      relay: this.host.relay,
      bundle: this.bundle,
      credential,
      timeoutMs: 12_000,
      logical: this.logical,
      openRelay: this.dependencies.openRelay,
      writeBundle: this.dependencies.writeBundle,
      randomBytes: this.dependencies.randomBytes,
      shouldKeepActive: () => !this.stopped && this.foreground
    })
    if (!result.ok && result.authenticationFailed) {
      this.logical.publishRouteOwnerState('auth-failed')
    }
    if (!result.ok) {
      return result
    }
    this.bundle = result.bundle
    const inactive = releaseInactiveMobileRelayRouteResult(
      this.logical,
      this.stopped,
      this.foreground
    )
    if (inactive) {
      return inactive
    }
    this.relayRotationPending = false
    this.hysteresis.recordMigration(this.dependencies.now())
    this.scheduleLeaseRotation(result.session)
    this.scheduleDirectProbe()
    return result
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
      this.timers.clearAll()
      this.relayRotationPending = false
      await this.credentialRotation.rotateIfNeeded()
    } finally {
      successful?.client.close()
      this.operationInFlight = false
      if (this.relayRotationPending) {
        void this.recoverRelay(true)
      }
      this.scheduleDirectProbe()
    }
  }

  private scheduleLeaseRotation(session: MobileRelayRpcSession): void {
    this.timers.scheduleLease(session, this.dependencies.now, () => {
      this.relayRotationPending = true
      void this.recoverRelay(true)
    })
  }
}
