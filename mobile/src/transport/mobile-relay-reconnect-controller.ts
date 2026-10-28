import {
  isMobileRelayCloseCode,
  mobileRelayRecoveryFor
} from '../../../src/shared/mobile-relay-close-codes'
import type { MobileRelayRpcSession } from './mobile-relay-rpc-session'
import { MobileE2EEAuthenticationError } from './mobile-e2ee-v2-physical-channel'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import { RELAY_STABLE_CONNECTION_MS, RelayRetryDelays } from './mobile-relay-retry-delays'
import { relayDirectorRetryAfterMs } from './mobile-relay-resume-director'
import { RelayCredentialEligibility } from './relay-credential-eligibility'
import type { RelayHostReachability } from './relay-host-reachability'
import { RelayRecoveryEvidence, type RelayRecoveryReporter } from './relay-recovery-evidence'
import { RelayRecoveryFailureCount } from './relay-recovery-failure-count'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ScheduleTimer } from './timer-scheduler'
import type { ConnectionState, ForegroundNudgeReason } from './types'

type RelayCredentialLease = { expiresAt: number; version: number }

export type RelayReconnectDependencies = {
  now: () => number
  randomBytes: (length: number) => Uint8Array
  setTimer: ScheduleTimer
  clearTimer: typeof clearTimeout
}

type RecoveryGate = 'external-signal' | 'fresh-credential'
type RetainableRelaySession = Pick<MobileRelayRpcSession, 'getFailure' | 'probeAfterBackground'>

export class RelayReconnectController {
  private readonly failureCount = new RelayRecoveryFailureCount(RELAY_STABLE_CONNECTION_MS)
  private readonly evidence = new RelayRecoveryEvidence()
  private activeRelayConnectedAt: number | null = null
  private nextAttemptAt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private activeSession: RetainableRelaySession | null = null
  private recoveryGate: RecoveryGate | null = null
  private gateReprobePending = false
  private gateReprobeStreak = 0
  private readonly credentials: RelayCredentialEligibility
  private readonly delays: RelayRetryDelays

  constructor(
    private readonly dependencies: RelayReconnectDependencies,
    private readonly onRetry: (forceReplacement?: boolean) => void
  ) {
    this.delays = new RelayRetryDelays(dependencies.randomBytes)
    this.credentials = new RelayCredentialEligibility(dependencies.now)
  }

  getFailureCount = (): number => this.failureCount.current()

  reportRecoveryTo(logical: RelayRecoveryReporter): void {
    this.failureCount.reportTo(logical.setRecoveryAttempt)
    this.evidence.reportTo(logical)
  }

  // The cell named the desktop's state outright; no failure streak to earn.
  assertHostReachability = (reachability: RelayHostReachability): void =>
    this.evidence.assert(reachability)

  handleForeground(logical: StableLogicalRpcClient, wasForeground: boolean): void {
    if (!wasForeground) {
      // Only a relay the background grace retained is still set here.
      this.activeSession?.probeAfterBackground()
      // Resume resets gated cadence even without clearing the credential gate; reopening must not wait a whole escalated tick.
      this.gateReprobeStreak = 0
      if (this.recoveryGate !== 'fresh-credential') {
        this.reset()
      }
    } else if (this.recoveryGate === 'external-signal') {
      this.liftGate()
    }
    // Why: revival nudges must honor failure cooldowns even when lease rotation is pending.
    this.onRetry()
  }

  // Probe healthy relays on focus/resume and replace on handoff without first suspending the active session.
  handleActiveNudge(
    logical: StableLogicalRpcClient,
    reason: ForegroundNudgeReason
  ): 'probe' | 'replace' | 'recover' {
    if (this.recoveryGate === 'external-signal') {
      this.liftGate()
    }
    // Manual app-resume retries bypass transport cooldown, but never a fresh-credential gate.
    const disconnectedOnResume = reason === 'app-resume' && logical.getState() === 'disconnected'
    if (disconnectedOnResume && this.recoveryGate !== 'fresh-credential') {
      this.reset()
    }
    if (
      this.recoveryGate !== 'fresh-credential' &&
      logical.getActivePath() === 'relay' &&
      logical.getState() === 'connected'
    ) {
      return reason === 'network-change' ? 'replace' : 'probe'
    }
    this.onRetry()
    return 'recover'
  }

  handleStateFailure(logical: StableLogicalRpcClient, state: ConnectionState): Error | null {
    if (!this.needsRecovery(state)) {
      return null
    }
    const failure = this.registerActiveFailure(logical)
    this.onRetry()
    return failure
  }

  needsRecovery = (state: ConnectionState): boolean =>
    state !== 'connected' && state !== 'connecting' && state !== 'handshaking'

  suspendActiveRelay(logical: StableLogicalRpcClient): void {
    if (logical.getActivePath() !== 'relay') {
      return
    }
    this.activeSession = null
    this.activeRelayConnectedAt = null
    logical.suspendActiveSession()
  }

  setActiveSession(session: RetainableRelaySession): void {
    // Authenticated relay success disproves the rejection streak.
    this.evidence.clear()
    this.activeSession = session
    this.activeRelayConnectedAt = this.dependencies.now()
    this.nextAttemptAt = 0
    this.liftGate()
  }

  resetForDirectConnection(): boolean {
    const needsCredentialRefresh =
      this.recoveryGate === 'fresh-credential' || this.credentials.hasRejected()
    this.activeSession = null
    this.activeRelayConnectedAt = null
    // Direct authentication uses the same device registry, so it also clears revocation/reachability evidence.
    this.evidence.clear()
    if (needsCredentialRefresh) {
      // Keep rejected credentials gated until durable rotation over direct; no relay reprobe is needed while direct lives.
      this.failureCount.reset()
      this.nextAttemptAt = 0
      this.recoveryGate = 'fresh-credential'
      this.gateReprobePending = false
      this.gateReprobeStreak = 0
      this.clearTimer()
    } else {
      this.reset()
    }
    return needsCredentialRefresh
  }

  completeCredentialRefresh(): void {
    if (this.recoveryGate === 'fresh-credential') {
      this.evidence.clear()
      this.credentials.clearRejected()
      this.reset()
    }
  }

  blocksUntilFreshCredential = (): boolean => this.recoveryGate === 'fresh-credential'

  hasDialableCredential(...credentials: (RelayCredentialLease | null | undefined)[]): boolean {
    return this.credentials.hasDialable(...credentials)
  }

  eligibleCredentials<T extends RelayCredentialLease>(
    ...credentials: Array<T | null | undefined>
  ): T[] {
    const eligible = this.credentials.eligible(...credentials)
    if (eligible.length === 0 && this.credentials.hasRejected()) {
      this.holdGate(true, 'fresh-credential')
    }
    return eligible
  }

  // Retry missing credentials slowly so later durable writes can restore access.
  armCredentialReprobe(): void {
    if (this.credentials.hasRejected()) {
      this.holdGate(true, 'fresh-credential')
      return
    }
    if (this.recoveryGate) {
      // Mint a gated tick’s pass token or shouldDefer would double the intended cadence.
      this.holdGate(true)
      return
    }
    // Missing/expired alone must not force rotation; retry durable reads through plain escalating cooldown.
    const delay = this.delays.gateReprobeDelayMs(this.gateReprobeStreak)
    this.nextAttemptAt = this.dependencies.now() + delay
    this.clearTimer()
    this.scheduleReprobeTick(delay, false)
  }

  // A durable bundle whose current version is not rejected reopens the gate.
  acceptFreshCredential(version: number): void {
    if (this.recoveryGate === 'fresh-credential' && !this.credentials.isRejected(version)) {
      this.liftGate()
    }
  }

  recordRejectedCredential = (version: number): void => this.credentials.recordRejected(version)

  registerActiveFailure(logical: StableLogicalRpcClient): Error | null {
    if (logical.getActivePath() !== 'relay') {
      return null
    }
    const failure = this.activeSession?.getFailure()
    this.activeSession = null
    if (failure) {
      // Why: active relay closes need the same cooldown as failed replacement dials.
      this.registerFailure(failure)
    } else {
      this.activeRelayConnectedAt = null
    }
    return failure ?? null
  }

  shouldDefer(): boolean {
    if (this.recoveryGate) {
      if (this.gateReprobePending) {
        // Why: the slow reprobe tick gets exactly one attempt through the gate.
        this.gateReprobePending = false
        return false
      }
      this.scheduleGateReprobe()
      return true
    }
    if (this.dependencies.now() < this.nextAttemptAt) {
      this.scheduleRetry()
      return true
    }
    return false
  }

  registerFailure(error: Error | null, scheduleRetry = true): void {
    // Bank rejection evidence before gated early return, except when a live authenticated relay disproves revocation.
    if (!this.activeSession) {
      this.evidence.record(error)
    }
    const recovery =
      error instanceof RelayOuterError && isMobileRelayCloseCode(error.code)
        ? mobileRelayRecoveryFor(error.code, 'phone-resume')
        : null
    if (
      this.recoveryGate === 'fresh-credential' ||
      (this.recoveryGate === 'external-signal' && recovery?.kind !== 'disable-relay-credential')
    ) {
      // Keep slow gated reprobes running only while active; foreground restores cadence.
      this.holdGate(scheduleRetry)
      return
    }
    const now = this.dependencies.now()
    const failureCount = this.failureCount.recordAfterConnection(this.activeRelayConnectedAt, now)
    // Why: only a stable authenticated Relay resets the failure streak.
    this.activeRelayConnectedAt = null
    // Director Retry-After paces overload; HTTP failures carry no relay close code.
    const delay =
      recovery?.kind === 'retry-after-host-offline'
        ? this.delays.hostOfflineDelayMs(this.failureCount.claimAttachTimeoutRedial(error))
        : this.delays.transportDelayMs(failureCount, relayDirectorRetryAfterMs(error))
    this.nextAttemptAt = now + delay
    if (error instanceof MobileE2EEAuthenticationError) {
      // E2EE rejection can be transient during credential commit; gate slow reprobes instead of waiting forever for a nudge.
      this.holdGate(scheduleRetry, 'external-signal')
      return
    }
    if (recovery?.kind === 'disable-relay-credential') {
      // Never retry rejected credentials fast; each slow attempt re-reads durable state.
      this.holdGate(scheduleRetry, 'fresh-credential')
      return
    }
    if (recovery?.kind === 'retry-after-host-offline') {
      // A prior transport timer must not bypass the slower known-offline retry.
      this.clearTimer()
    }
    this.recoveryGate = null
    if (!scheduleRetry) {
      this.clearTimer()
      return
    }
    this.scheduleRetry(delay)
  }

  retryDelayMs(minimumMs: number): number | null {
    if (this.recoveryGate) {
      return null
    }
    return Math.max(minimumMs, this.nextAttemptAt - this.dependencies.now())
  }

  reset(): void {
    this.failureCount.reset()
    this.activeRelayConnectedAt = null
    this.nextAttemptAt = 0
    this.liftGate()
  }

  clear(): void {
    this.clearTimer()
    this.gateReprobePending = false
    this.activeSession = null
    this.activeRelayConnectedAt = null
  }

  private clearTimer(): void {
    if (this.timer) {
      this.dependencies.clearTimer(this.timer)
      this.timer = null
    }
  }

  private scheduleRetry(delayMs?: number): void {
    if (this.timer) {
      return
    }
    const delay = delayMs ?? Math.max(0, this.nextAttemptAt - this.dependencies.now())
    this.timer = this.dependencies.setTimer(() => {
      this.timer = null
      this.onRetry()
    }, delay)
  }

  private scheduleGateReprobe(): void {
    this.scheduleReprobeTick(this.delays.gateReprobeDelayMs(this.gateReprobeStreak), true)
  }

  private scheduleReprobeTick(delay: number, mintToken: boolean): void {
    if (this.timer) {
      return
    }
    this.timer = this.dependencies.setTimer(() => {
      this.timer = null
      // Advance cadence once per fired tick, not on repeated arm attempts.
      this.gateReprobeStreak = Math.min(this.gateReprobeStreak + 1, 8)
      // Mint only while this gate holds so a later gate cannot spend a stale bypass token.
      if (mintToken && this.recoveryGate) {
        this.gateReprobePending = true
      }
      this.onRetry()
    }, delay)
  }

  // Keep only slow reprobes under a gate, and no timers while backgrounded/stopped.
  private holdGate(scheduleRetry: boolean, gate = this.recoveryGate): void {
    this.recoveryGate = gate
    this.clearTimer()
    if (scheduleRetry) {
      this.scheduleGateReprobe()
    }
  }

  // Clear timer/token/cadence with the gate so stale reprobes cannot swallow the next fast retry.
  private liftGate(): void {
    this.recoveryGate = null
    this.gateReprobePending = false
    this.gateReprobeStreak = 0
    this.clearTimer()
  }
}
