import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'
import { DirectReturnProbe } from './mobile-direct-return-probe'
import { RelayReconnectController } from './mobile-relay-reconnect-controller'
import { RelayLeaseRotationTimer } from './mobile-relay-lease-rotation-timer'
import { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import {
  liveRelayLeaseExpiry,
  suspendRelayIfStillConnected
} from './mobile-endpoint-supervisor-support'
import { selectDialableRelayCredentials } from './mobile-relay-credential-selection'
import { createRelayRecoveryLog, type RelayRecoveryLog } from './mobile-relay-recovery-log'
import {
  mobileRelayCredentialNeedsRotation,
  rotateMobileRelayCredential
} from './mobile-relay-credential-rotation'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { MobileEndpointNudgeRouter } from './mobile-endpoint-nudge-router'
import { MobileRelayDirectGraceTimer } from './mobile-relay-direct-grace-timer'
import { MobileRelaySessionEstablisher } from './mobile-relay-session-establisher'
import * as recoveryPresentation from './mobile-relay-recovery-presentation'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ForegroundNudgeReason } from './types'
import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import { MobileRelayBackgroundGrace } from './mobile-relay-background-grace'
import {
  logRelayConnected,
  logRelayCredentialUnavailable,
  logRelayDialFailure
} from './mobile-relay-diagnostic-log'

export type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'

const DIRECT_OBSERVATION_MS = 30_000
const MINIMUM_DWELL_MS = 60_000
const FAILURE_COOLDOWN_MS = 60_000

export class MobileEndpointSupervisor {
  private bundle: MobileRelayCredentialBundle | null = null
  private stopped = false
  private operationInFlight = false
  private pendingReplace = false
  private readonly nudgeRouter: MobileEndpointNudgeRouter
  private credentialRotationInFlight = false
  private relayRotationPending = false
  private unsubscribeState: (() => void) | null = null
  private readonly hysteresis: MobileEndpointHysteresis
  private readonly relayReconnect: RelayReconnectController
  private readonly leaseRotation: RelayLeaseRotationTimer
  private readonly logRelay: RelayRecoveryLog
  private readonly directProbe: DirectReturnProbe
  private readonly directGrace: MobileRelayDirectGraceTimer
  private readonly backgroundGrace: MobileRelayBackgroundGrace
  private readonly sessionEstablisher: MobileRelaySessionEstablisher

  constructor(
    private readonly logical: StableLogicalRpcClient,
    private readonly hostId: string,
    relay: MobileRelayEndpoint,
    private readonly dependencies: MobileEndpointSupervisorDependencies
  ) {
    this.hysteresis = new MobileEndpointHysteresis(dependencies.now(), {
      directSuccessesRequired: 3,
      directObservationMs: DIRECT_OBSERVATION_MS,
      failureCooldownMs: FAILURE_COOLDOWN_MS,
      minimumDwellMs: MINIMUM_DWELL_MS
    })
    this.logRelay = createRelayRecoveryLog(dependencies.now, dependencies.onLog)
    this.relayReconnect = new RelayReconnectController(dependencies, this.recoverRelay.bind(this))
    this.relayReconnect.reportRecoveryTo(logical)
    this.nudgeRouter = new MobileEndpointNudgeRouter({
      logical,
      controller: this.relayReconnect,
      isStopped: () => this.stopped,
      isForeground: () => this.backgroundGrace.isForeground(),
      setForeground: (foreground) => this.setForeground(foreground),
      replaceRelay: () => void this.recoverRelay(true, true),
      scheduleDirectProbe: () => this.directProbe.schedule(0)
    })
    this.leaseRotation = new RelayLeaseRotationTimer(dependencies, () => {
      this.relayRotationPending = true
      void this.recoverRelay(true)
    })
    // The race owns recovery and must book shared cooldown on failure; recoverRelay already guards stopped/background state.
    this.directGrace = new MobileRelayDirectGraceTimer(dependencies, logical, () => {
      void this.recoverRelay(true, true)
    })
    this.sessionEstablisher = new MobileRelaySessionEstablisher({
      logical,
      controller: this.relayReconnect,
      openRelay: dependencies.openRelay,
      randomBytes: dependencies.randomBytes,
      writeBundle: dependencies.writeBundle,
      isActive: () => this.isActive(),
      isForeground: () => this.backgroundGrace.isForeground(),
      isStopped: () => this.stopped,
      hostId,
      relay,
      resolveRelay: dependencies.resolveRelay,
      setRelayRouting: dependencies.setRelayRouting,
      bundle: () => this.bundle,
      adoptBundle: (bundle) => (this.bundle = bundle),
      recordMigration: () => {
        this.relayRotationPending = false
        this.hysteresis.recordMigration(dependencies.now())
        logRelayConnected(this.logRelay)
      },
      scheduleLease: (expiry) =>
        this.leaseRotation.scheduleFromLease(
          liveRelayLeaseExpiry(this.logical, this.stopped, expiry)
        ),
      scheduleDirectProbe: () => this.directProbe.schedule(),
      onBookkeepingError: (error) =>
        this.logRelay('relay bookkeeping failed after migration', error.message.slice(0, 80)),
      onDialFailure: (error) => logRelayDialFailure(this.logRelay, error)
    })
    this.directProbe = new DirectReturnProbe(dependencies, {
      hysteresis: this.hysteresis,
      canSchedule: () => this.isActive() && this.logical.getActivePath() === 'relay',
      canAttempt: () => this.isActive() && !this.operationInFlight,
      beginOperation: () => (this.operationInFlight = true),
      migrate: (client, path, abort) => this.logical.migrateTo(client, path, undefined, abort),
      onDirectMigrated: async () => {
        this.leaseRotation.clear()
        this.relayRotationPending = false
        await this.rotateCredentialIfNeeded(this.relayReconnect.resetForDirectConnection())
      },
      afterProbe: () => {
        this.operationInFlight = false
        if (
          this.pendingReplace ||
          this.relayRotationPending ||
          this.logical.getState() !== 'connected'
        ) {
          void this.recoverRelay(this.relayRotationPending)
        }
      }
    })
    this.backgroundGrace = new MobileRelayBackgroundGrace(
      dependencies,
      logical,
      this.relayReconnect,
      this.leaseRotation,
      this.directProbe,
      this.directGrace
    )
  }

  async start(): Promise<void> {
    this.bundle = await this.dependencies.readBundle(this.hostId).catch(() => null)
    if (this.stopped) {
      return
    }
    if (!this.bundle) {
      // Re-read durable credentials each recovery attempt so an opening keychain race cannot disable relay for the process lifetime.
      this.logRelay('credential bundle unavailable at start; recovery will re-read')
    }
    this.unsubscribeState = this.logical.onStateChange((state) => {
      if (state === 'connected') {
        this.directGrace.clear()
        if (this.logical.getActivePath() !== 'relay') {
          void this.rotateCredentialIfNeeded(this.relayReconnect.resetForDirectConnection())
        }
        this.directProbe.schedule()
      } else if (!this.backgroundGrace.isForeground()) {
        this.backgroundGrace.handleStateFailure()
      } else {
        // Why: the direct client enters reconnecting after its first failed
        // dial and may never publish disconnected while its retry loop lives.
        recoveryPresentation.onActiveFailure(this.logical, this.relayReconnect, state, this.bundle)
        const relayFailure = this.relayReconnect.handleStateFailure(this.logical, state)
        logRelayDialFailure(this.logRelay, relayFailure, 'active-session')
      }
    })
    if (this.relayReconnect.needsRecovery(this.logical.getState())) {
      // Why: the first direct dial can fail while encrypted relay credentials
      // are still loading, before the supervisor subscribes to state changes.
      await this.recoverRelay()
    } else {
      this.directProbe.schedule()
      this.directGrace.arm()
    }
  }

  setForeground(foreground: boolean): void {
    this.backgroundGrace.setForeground(foreground)
    if (foreground && this.relayRotationPending) {
      void this.recoverRelay(true)
    }
  }

  nudge = (reason: ForegroundNudgeReason): void => this.nudgeRouter.nudge(reason)

  stop(): void {
    this.stopped = true
    this.directProbe.stop()
    this.unsubscribeState?.()
    this.unsubscribeState = null
    this.backgroundGrace.stop()
  }

  private isActive(): boolean {
    return !this.stopped && this.backgroundGrace.isForeground()
  }

  // forceReplacement bypasses live-direct guards; ownsRecovery books cooldown and retires stale sessions on failure.
  // Lease rotation leaves retry ownership to its timer.
  private async recoverRelay(forceReplacement = false, ownsRecovery = false): Promise<void> {
    if (!this.isActive()) {
      return
    }
    if (this.operationInFlight) {
      // Queue handoff intent while a direct probe holds the mutex; afterProbe replays it.
      this.pendingReplace ||= forceReplacement && ownsRecovery
      return
    }
    if (this.pendingReplace) {
      this.pendingReplace = false
      forceReplacement = true
      ownsRecovery = true
    }
    // Give connecting/handshaking direct its grace period before unforced relay recovery.
    if (!forceReplacement && !this.relayReconnect.needsRecovery(this.logical.getState())) {
      return
    }
    // Share cooldown across overlapping resume, revival and lease failures to prevent reconnect churn.
    if (this.relayReconnect.shouldDefer()) {
      if (ownsRecovery) {
        // Without a dial, no session was disproven; keep intent queued for forced recovery after cooldown.
        this.pendingReplace = true
      }
      this.logRelay('recovery deferred by cooldown or gate')
      return
    }
    this.operationInFlight = true
    let retryAfterOperation = false
    try {
      const selection = await selectDialableRelayCredentials({
        bundle: this.bundle,
        controller: this.relayReconnect,
        readBundle: () => this.dependencies.readBundle(this.hostId),
        onAdoptedFresherBundle: () => this.logRelay('adopted fresher durable credential bundle')
      })
      this.bundle = selection.bundle
      if (selection.credentials.length === 0) {
        this.logical.setRecoveryPath(null)
        // Distinguish expired credentials from missing keychain data in diagnostics.
        logRelayCredentialUnavailable(this.logRelay, selection.bundle !== null)
        this.relayReconnect.armCredentialReprobe()
        if (ownsRecovery) {
          // Preserve session/intent until credentials return; reprobe will replace without breaking the live session.
          this.pendingReplace = true
        }
        return
      }
      const recoveryNeeded =
        forceReplacement || this.relayReconnect.needsRecovery(this.logical.getState())
      if (!this.isActive() || !recoveryNeeded) {
        return
      }
      this.logical.setRecoveryPath('relay', this.relayReconnect.getFailureCount())
      const dialed = await this.sessionEstablisher.dialEligible(selection.credentials)
      if (dialed.outcome === 'established') {
        // Why: a fresh socket satisfies any replacement intent queued mid-dial.
        this.pendingReplace = false
        retryAfterOperation = this.logical.getState() !== 'connected'
        return
      }
      if (dialed.outcome === 'aborted') {
        this.logical.setRecoveryPath(null)
        // Withdrawal is not failure; booking cooldown would delay genuine later recovery.
        return
      }
      // Record a dial completing after cleanup without recreating foreground timers.
      const scheduleRetry = (!forceReplacement || ownsRecovery) && this.isActive()
      this.relayReconnect.registerFailure(dialed.error, scheduleRetry)
      recoveryPresentation.clearIfCredentialBlocked(this.logical, this.relayReconnect)
      if (ownsRecovery) {
        suspendRelayIfStillConnected(this.relayReconnect, this.logical)
      }
    } finally {
      this.operationInFlight = false
      if (forceReplacement && this.relayRotationPending && this.isActive()) {
        this.leaseRotation.armRetry(this.relayReconnect.retryDelayMs(5000))
      }
      // Why: the active relay can drop while migration follow-up still owns the mutex.
      if (retryAfterOperation && this.isActive()) {
        void this.recoverRelay()
      }
    }
  }

  private async rotateCredentialIfNeeded(force = false): Promise<void> {
    if (
      this.stopped ||
      this.credentialRotationInFlight ||
      !this.bundle ||
      this.logical.getActivePath() === 'relay' ||
      (!force && !mobileRelayCredentialNeedsRotation(this.bundle, this.dependencies.now()))
    ) {
      return
    }
    this.credentialRotationInFlight = true
    let credentialRefreshed = false
    try {
      const result = await rotateMobileRelayCredential({
        client: this.logical,
        bundle: this.bundle,
        writeBundle: this.dependencies.writeBundle,
        randomBytes: this.dependencies.randomBytes
      })
      this.bundle = result.bundle
      // Why: a scheduled rotation can finish after the old credential enters the rejection gate.
      credentialRefreshed = true
      await this.sessionEstablisher.adoptRelay(result.relay)
    } catch {
      // Retain pending material for direct reconciliation before generating another install key.
    } finally {
      if (credentialRefreshed) {
        this.relayReconnect.completeCredentialRefresh()
      }
      this.credentialRotationInFlight = false
      if (
        credentialRefreshed &&
        this.isActive() &&
        this.relayReconnect.needsRecovery(this.logical.getState())
      ) {
        void this.recoverRelay()
      }
    }
  }
}
