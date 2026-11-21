import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'
import { DirectReturnProbe } from '../relay/mobile-direct-return-probe'
import { RelayReconnectController } from '../relay/mobile-relay-reconnect-controller'
import { RelayLeaseRotationTimer } from '../relay/mobile-relay-lease-rotation-timer'
import { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import { liveRelayLeaseExpiry, suspendRelayIfStillConnected } from './mobile-relay-replacement'
import { selectDialableRelayCredentials } from '../relay/mobile-relay-credential-selection'
import {
  createRelayRecoveryLog,
  type RelayRecoveryLog
} from '../../diagnostics/connection/mobile-relay-recovery-log'
import { createRelayDeferralLog } from '../../diagnostics/connection/mobile-relay-deferral-log'
import type { MobileRelayCredentialBundle } from '../../host-credentials/mobile-relay-credential-bundle'
import { MobileEndpointNudgeRouter } from './mobile-endpoint-nudge-router'
import { MobileRelayDirectGraceTimer } from '../relay/mobile-relay-direct-grace-timer'
import { MobileRelaySessionEstablisher } from '../relay/mobile-relay-session-establisher'
import * as recoveryPresentation from '../relay/mobile-relay-recovery-presentation'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ForegroundNudgeReason } from './connection-state'
import type { MobileRelayEndpoint } from '../../../../src/shared/remote-runtime/relay/mobile-relay-credential-contract'
import { MobileRelayBackgroundGrace } from '../relay/mobile-relay-background-grace'
import * as relayDiagnosticLog from '../../diagnostics/connection/mobile-relay-diagnostic-log'
import { MobileEndpointCredentialRotator } from './mobile-endpoint-credential-rotator'

export class MobileEndpointSupervisor {
  private bundle: MobileRelayCredentialBundle | null = null
  private stopped = false
  private operationInFlight = false
  private pendingReplace = false
  // A forced race queued behind a relay operation; that operation's finally replays it.
  private replaceQueuedBehindRecovery = false
  private readonly nudgeRouter: MobileEndpointNudgeRouter
  private relayRotationPending = false
  private unsubscribeState: (() => void) | null = null
  private readonly hysteresis: MobileEndpointHysteresis
  private readonly relayReconnect: RelayReconnectController
  private readonly leaseRotation: RelayLeaseRotationTimer
  private readonly logRelay: RelayRecoveryLog
  // Lazy: logRelay is assigned in the constructor.
  private readonly logDeferral = createRelayDeferralLog((m, d) => this.logRelay(m, d))
  private readonly directProbe: DirectReturnProbe
  private readonly directGrace: MobileRelayDirectGraceTimer
  private readonly backgroundGrace: MobileRelayBackgroundGrace
  private readonly sessionEstablisher: MobileRelaySessionEstablisher
  private readonly credentialRotator: MobileEndpointCredentialRotator

  constructor(
    private readonly logical: StableLogicalRpcClient,
    private readonly hostId: string,
    relay: MobileRelayEndpoint,
    private readonly dependencies: MobileEndpointSupervisorDependencies
  ) {
    this.hysteresis = new MobileEndpointHysteresis(dependencies.now())
    this.logRelay = createRelayRecoveryLog(dependencies.now, dependencies.onLog)
    this.relayReconnect = new RelayReconnectController(dependencies, this.recoverRelay.bind(this))
    this.relayReconnect.reportRecoveryTo(logical)
    this.nudgeRouter = new MobileEndpointNudgeRouter({
      logical,
      controller: this.relayReconnect,
      isStopped: () => this.stopped,
      isForeground: () => this.backgroundGrace.isForeground(),
      setForeground: (foreground) => this.setForeground(foreground),
      scheduleDirectProbe: () => this.directProbe.schedule(0),
      readLocalNetwork: dependencies.readLocalNetwork,
      onLocalNetworkArrival: () => this.directProbe.arrive()
    })
    this.leaseRotation = new RelayLeaseRotationTimer(dependencies, () => {
      this.relayRotationPending = true
      void this.recoverRelay(true)
    })
    // The race owns recovery and must book shared cooldown on failure; recoverRelay already guards stopped/background state.
    this.directGrace = new MobileRelayDirectGraceTimer(dependencies, logical, hostId, () => {
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
        relayDiagnosticLog.logRelayConnected(this.logRelay)
      },
      scheduleLease: (expiry) =>
        this.leaseRotation.scheduleFromLease(
          liveRelayLeaseExpiry(this.logical, this.stopped, expiry)
        ),
      scheduleDirectProbe: () => this.directProbe.schedule(),
      onBookkeepingError: (error) =>
        this.logRelay('relay bookkeeping failed after migration', error.message.slice(0, 80)),
      onDialFailure: (error) => relayDiagnosticLog.logRelayDialFailure(this.logRelay, error)
    })
    this.credentialRotator = new MobileEndpointCredentialRotator({
      logical,
      dependencies,
      isStopped: () => this.stopped,
      bundle: () => this.bundle,
      adoptBundle: (bundle) => (this.bundle = bundle),
      adoptRelay: (resolved) => this.sessionEstablisher.adoptRelay(resolved),
      completeCredentialRefresh: () => this.relayReconnect.completeCredentialRefresh(),
      recoverIfNeeded: () => {
        if (this.isActive() && this.relayReconnect.needsRecovery(this.logical.getState())) {
          void this.recoverRelay()
        }
      }
    })
    this.directProbe = new DirectReturnProbe(dependencies, {
      hysteresis: this.hysteresis,
      canSchedule: () =>
        !dependencies.directUnavailable &&
        this.isActive() &&
        this.logical.getActivePath() === 'relay',
      canAttempt: () => this.isActive() && !this.operationInFlight,
      beginOperation: () => (this.operationInFlight = true),
      migrate: (client, path, abort) => this.logical.migrateTo(client, path, undefined, abort),
      onDirectMigrated: async () => {
        this.leaseRotation.clear()
        this.relayRotationPending = false
        await this.credentialRotator.rotateIfNeeded(this.relayReconnect.resetForDirectConnection())
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
    // Recovery re-reads durable credentials each attempt, so an opening keychain race cannot disable relay for the process lifetime.
    relayDiagnosticLog.logRelaySupervisorStarted(this.logRelay, this.logical, this.bundle)
    this.unsubscribeState = this.logical.onStateChange((state) => {
      if (state === 'connected') {
        this.directGrace.onConnected()
        if (this.logical.getActivePath() !== 'relay') {
          // A direct win answers any race intent deferred by cooldown; replaying it would replace a healthy LAN.
          this.pendingReplace = false
          void this.credentialRotator.rotateIfNeeded(this.relayReconnect.resetForDirectConnection())
        }
        this.directProbe.schedule()
      } else if (!this.backgroundGrace.isForeground()) {
        this.backgroundGrace.handleStateFailure()
      } else {
        // Why: the direct client enters reconnecting after its first failed
        // dial and may never publish disconnected while its retry loop lives.
        recoveryPresentation.onActiveFailure(this.logical, this.relayReconnect, state, this.bundle)
        const relayFailure = this.relayReconnect.handleStateFailure(this.logical, state)
        relayDiagnosticLog.logRelayDialFailure(this.logRelay, relayFailure, 'active-session')
        // Redials keep direct in connecting, which unforced recovery waits out; one timer per outage races them.
        if (this.logical.getActivePath() !== 'relay') {
          this.directGrace.arm()
        }
      }
    })
    void this.directGrace.loadLastGoodPath()
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
    if (!foreground) {
      this.replaceQueuedBehindRecovery = false
    }
    this.backgroundGrace.setForeground(foreground)
    if (foreground && this.relayRotationPending) {
      void this.recoverRelay(true)
    }
  }

  nudge = (reason: ForegroundNudgeReason): void => this.nudgeRouter.nudge(reason)

  stop(): void {
    this.stopped = true
    this.replaceQueuedBehindRecovery = false
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
      // Queue handoff intent while a direct probe or relay operation holds the mutex; afterProbe or finally replays it.
      this.pendingReplace ||= forceReplacement && ownsRecovery
      this.replaceQueuedBehindRecovery ||= forceReplacement && ownsRecovery
      return
    }
    forceReplacement ||= this.pendingReplace
    ownsRecovery ||= this.pendingReplace
    this.pendingReplace = false
    // Give connecting/handshaking direct its grace period before unforced relay recovery.
    if (!forceReplacement && !this.recoveryDue()) {
      return
    }
    // Share cooldown across overlapping resume, revival and lease failures to prevent reconnect churn.
    const deferral = this.relayReconnect.deferral()
    if (deferral) {
      // Without a dial, no session was disproven; keep intent queued for forced recovery after cooldown.
      this.pendingReplace ||= ownsRecovery
      this.logDeferral(deferral)
      return
    }
    this.operationInFlight = true
    this.replaceQueuedBehindRecovery = false
    let retryAfterOperation = false
    // Only an operation that withdrew without dialing replays a queued race; a failed dial books its own retry.
    let withdrewWithoutDial = false
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
        relayDiagnosticLog.logRelayCredentialUnavailable(this.logRelay, selection.bundle !== null)
        this.relayReconnect.armCredentialReprobe()
        if (ownsRecovery) {
          // Preserve session/intent until credentials return; reprobe will replace without breaking the live session.
          this.pendingReplace = true
        }
        return
      }
      const recoveryNeeded = forceReplacement || this.recoveryDue()
      if (!this.isActive() || !recoveryNeeded) {
        withdrewWithoutDial = true
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
        withdrewWithoutDial = true
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
      // Why: an unforced operation that skipped its dial (direct redialing) or was aborted
      // schedules no retry, so a direct-grace race queued behind it would wait for the next state change.
      const replayQueuedReplace =
        withdrewWithoutDial && this.replaceQueuedBehindRecovery && this.pendingReplace
      this.replaceQueuedBehindRecovery = false
      // Why: the active relay can drop while migration follow-up still owns the mutex.
      if ((retryAfterOperation || replayQueuedReplace) && this.isActive()) {
        this.recoverRelay().catch((error: unknown) =>
          this.logRelay('relay recovery replay failed', String(error).slice(0, 80))
        )
      }
    }
  }

  private recoveryDue = (): boolean =>
    this.relayReconnect.needsRecovery(this.logical.getState()) || this.directGrace.raceUnderway()
}
