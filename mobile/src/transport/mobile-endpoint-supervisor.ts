import { openAuthenticatedDirectEndpoint } from './mobile-direct-endpoint-probe'
import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'
import { RelayReconnectController } from './mobile-relay-reconnect-controller'
import { RelayLeaseRotationTimer } from './mobile-relay-lease-rotation-timer'
import { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import { MobileDirectProbeTimer } from './mobile-direct-probe-timer'
import { canRecoverMobileRelay } from './mobile-relay-recovery-eligibility'
import { encodeBase64Url, logRelayLifecycle, toError } from './mobile-endpoint-supervisor-support'
import { applyResumeConfirmation } from './mobile-relay-credential-rotation'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { refreshMobileRelayCredentialIfNeeded } from './mobile-relay-credential-refresh'
import { tryRelayCredential } from './mobile-relay-credential-trial'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { HostProfile } from './types'

export type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'

const DIRECT_PROBE_INTERVAL_MS = 15_000
const DIRECT_OBSERVATION_MS = 30_000
const MINIMUM_DWELL_MS = 60_000
const FAILURE_COOLDOWN_MS = 60_000

export class MobileEndpointSupervisor {
  private bundle: MobileRelayCredentialBundle | null = null
  private stopped = false
  private foreground = true
  private operationInFlight = false
  private credentialRotationInFlight = false
  private relayRotationPending = false
  private readonly directProbeTimer = new MobileDirectProbeTimer()
  private unsubscribeState: (() => void) | null = null
  private readonly hysteresis: MobileEndpointHysteresis
  private readonly relayReconnect: RelayReconnectController
  private readonly leaseRotation: RelayLeaseRotationTimer

  constructor(
    private readonly logical: StableLogicalRpcClient,
    private host: HostProfile,
    private readonly dependencies: MobileEndpointSupervisorDependencies
  ) {
    this.hysteresis = new MobileEndpointHysteresis(dependencies.now(), {
      directSuccessesRequired: 3,
      directObservationMs: DIRECT_OBSERVATION_MS,
      failureCooldownMs: FAILURE_COOLDOWN_MS,
      minimumDwellMs: MINIMUM_DWELL_MS
    })
    this.relayReconnect = new RelayReconnectController(dependencies, this.recoverRelay.bind(this))
    this.leaseRotation = new RelayLeaseRotationTimer(dependencies, () => {
      this.relayRotationPending = true
      void this.recoverRelay(true)
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
          void this.rotateCredentialIfNeeded(this.relayReconnect.resetForDirectConnection())
        }
        this.scheduleDirectProbe()
      } else {
        this.relayReconnect.handleStateFailure(this.logical, state)
      }
    })
    if (this.logical.getState() !== 'connected') {
      await this.recoverRelay(false, !this.relayReconnect.needsRecovery(this.logical.getState()))
    } else {
      this.scheduleDirectProbe()
    }
  }

  setForeground(foreground: boolean): void {
    const wasForeground = this.foreground
    this.foreground = foreground
    if (foreground) {
      this.relayReconnect.handleForeground(this.logical, wasForeground)
      this.scheduleDirectProbe(0)
    } else {
      // Why: background phones must not hold billed relay data splices.
      this.relayReconnect.suspendActiveRelay(this.logical)
      this.clearDirectProbeTimer()
      this.relayReconnect.clear()
      this.leaseRotation.clear()
    }
  }

  stop(): void {
    this.stopped = true
    this.unsubscribeState?.()
    this.unsubscribeState = null
    this.clearDirectProbeTimer()
    this.relayReconnect.clear()
    this.leaseRotation.clear()
  }

  private async recoverRelay(forceReplacement = false, allowDirectRace = false): Promise<void> {
    if (
      !canRecoverMobileRelay({
        stopped: this.stopped,
        foreground: this.foreground,
        operationInFlight: this.operationInFlight,
        hasBundle: this.bundle !== null,
        hasRelay: this.host.relay !== undefined,
        forceReplacement,
        allowDirectRace,
        state: this.logical.getState(),
        needsRecovery: this.relayReconnect.needsRecovery.bind(this.relayReconnect)
      })
    ) {
      return
    }
    if (this.relayReconnect.shouldDefer()) {
      return
    }
    const bundle = this.bundle
    if (!bundle) {
      return
    }

    logRelayLifecycle(this.dependencies, 'start', this.logical.getState())

    this.operationInFlight = true
    let lastError: Error | null = null
    let retryAfterOperation = false
    try {
      const credentials = this.relayReconnect.eligibleCredentials(bundle.current, bundle.grace)
      for (const credential of credentials) {
        const result = await tryRelayCredential({
          credential,
          host: this.host,
          logicalState: () => this.logical.getState(),
          logicalActivePath: () => this.logical.getActivePath(),
          openAndMigrateRelay: (c) => this.openAndMigrateRelay(c),
          resolveRelay: (a) => this.dependencies.resolveRelay(a),
          saveHost: this.dependencies.saveHost,
          updateHost: (host) => {
            this.host = host
          }
        })
        if (result.ok) {
          logRelayLifecycle(this.dependencies, 'success')
          retryAfterOperation = this.logical.getState() !== 'connected'
          return
        }
        lastError = result.error

        if (this.logical.getState() === 'connected' && this.logical.getActivePath() !== 'relay') {
          logRelayLifecycle(this.dependencies, 'cancel')
          break
        }

        if (this.relayReconnect.shouldTryGraceAfterRelayFailure(result.error)) {
          this.relayReconnect.recordRejectedCredential(credential.version)
        } else {
          break
        }
      }
      if (credentials.length > 0) {
        this.relayReconnect.registerFailure(
          lastError,
          !forceReplacement &&
            this.foreground &&
            !this.stopped &&
            this.relayReconnect.needsRecovery(this.logical.getState())
        )
      }
    } finally {
      this.operationInFlight = false
      if (forceReplacement && this.relayRotationPending && !this.stopped && this.foreground) {
        this.leaseRotation.armRetry(this.relayReconnect.retryDelayMs(5000))
      }
      if (retryAfterOperation) {
        void this.recoverRelay()
      }
    }
  }

  private async openAndMigrateRelay(credential: {
    token: string
    version: number
  }): Promise<{ ok: true } | { ok: false; error: Error }> {
    if (this.stopped || !this.foreground || !this.host.relay || !this.bundle) {
      return { ok: false, error: new Error('relay state missing') }
    }
    const session = this.dependencies.openRelay(
      this.host.relay,
      credential,
      `confirm-${encodeBase64Url(this.dependencies.randomBytes(16))}`
    )
    try {
      await this.logical.migrateTo(session, 'relay')
      this.relayReconnect.setActiveSession(session)
      if (!this.foreground) {
        this.relayReconnect.suspendActiveRelay(this.logical)
      }
      this.relayRotationPending = false
      this.hysteresis.recordMigration(this.dependencies.now())
      const confirmation = session.getResumeConfirmation()
      if (confirmation) {
        this.bundle = applyResumeConfirmation(this.bundle, credential.version, confirmation)
        await this.dependencies.writeBundle(this.bundle).catch(() => {})
      }
      this.leaseRotation.scheduleFromLease(
        this.stopped || !this.foreground ? null : session.getLeaseExpiresAt()
      )
      this.scheduleDirectProbe()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: session.getFailure() ?? toError(error) }
    }
  }

  private scheduleDirectProbe(delayMs = DIRECT_PROBE_INTERVAL_MS): void {
    this.directProbeTimer.schedule({
      canSchedule: !this.stopped && this.foreground && this.logical.getActivePath() === 'relay',
      delayMs,
      setTimer: this.dependencies.setTimer,
      onTimer: () => void this.probeDirect()
    })
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
      this.leaseRotation.clear()
      this.relayRotationPending = false
      await this.rotateCredentialIfNeeded(this.relayReconnect.resetForDirectConnection())
    } finally {
      successful?.client.close()
      this.operationInFlight = false
      if (this.relayRotationPending || this.logical.getState() !== 'connected') {
        void this.recoverRelay(this.relayRotationPending)
      }
      this.scheduleDirectProbe()
    }
  }

  private async rotateCredentialIfNeeded(force = false): Promise<void> {
    if (this.credentialRotationInFlight) {
      return
    }
    this.credentialRotationInFlight = true
    let credentialRefreshed = false
    try {
      const result = await refreshMobileRelayCredentialIfNeeded({
        force,
        stopped: this.stopped,
        activePath: this.logical.getActivePath(),
        now: this.dependencies.now(),
        client: this.logical,
        bundle: this.bundle,
        writeBundle: this.dependencies.writeBundle,
        randomBytes: this.dependencies.randomBytes,
        host: this.host,
        saveHost: this.dependencies.saveHost
      })
      if (!result) {
        return
      }
      this.bundle = result.bundle
      this.host = result.host
      this.relayReconnect.completeCredentialRefresh()
      credentialRefreshed = true
    } finally {
      this.credentialRotationInFlight = false
      if (
        credentialRefreshed &&
        !this.stopped &&
        this.foreground &&
        this.relayReconnect.needsRecovery(this.logical.getState())
      ) {
        void this.recoverRelay()
      }
    }
  }

  private clearDirectProbeTimer(): void {
    this.directProbeTimer.clear(this.dependencies.clearTimer)
  }
}
