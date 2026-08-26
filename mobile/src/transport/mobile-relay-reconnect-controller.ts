import {
  isMobileRelayCloseCode,
  MOBILE_RELAY_CLOSE_CODE,
  mobileRelayRecoveryFor
} from '../../../src/shared/mobile-relay-close-codes'
import type { MobileRelayRpcSession } from './mobile-relay-rpc-session'
import { MobileE2EEAuthenticationError } from './mobile-e2ee-v2-physical-channel'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import { RELAY_STABLE_CONNECTION_MS, RelayRetryDelays } from './mobile-relay-retry-delays'
import { RelayCredentialEligibility } from './relay-credential-eligibility'
import { RelayPairingRejectionLatch } from './relay-pairing-rejection-latch'
import { RelayRecoveryFailureCount } from './relay-recovery-failure-count'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionState, ForegroundNudgeReason } from './types'

type RelayCredentialLease = { expiresAt: number; version: number }

export type RelayReconnectDependencies = {
  now: () => number
  randomBytes: (length: number) => Uint8Array
  setTimer: typeof setTimeout
  clearTimer: typeof clearTimeout
}

type RecoveryGate = 'external-signal' | 'fresh-credential'

export class RelayReconnectController {
  private readonly failureCount = new RelayRecoveryFailureCount(RELAY_STABLE_CONNECTION_MS)
  private readonly pairingRejection = new RelayPairingRejectionLatch()
  private activeRelayConnectedAt: number | null = null
  private nextAttemptAt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private activeSession: MobileRelayRpcSession | null = null
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

  getFailureCount(): number {
    return this.failureCount.current()
  }

  reportRecoveryTo(logical: StableLogicalRpcClient): void {
    this.failureCount.reportTo(logical.setRecoveryAttempt)
    this.pairingRejection.reportTo(logical.setPairingRejected)
  }

  handleForeground(logical: StableLogicalRpcClient, wasForeground: boolean): void {
    if (!wasForeground) {
      // Why: an app resume is a fresh signal, unlike repeated network-flap
      // nudges — it resets the gated cadence even when it cannot lift the
      // credential gate, so reopening the app never waits out a 15min tick.
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

  // Classifies a nudge that arrives while already foreground. A healthy relay is
  // never suspended here: focus/app-resume probe it, a network change replaces it
  // make-before-break — suspending first was the grey-blink bug (S2).
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

  handleStateFailure(logical: StableLogicalRpcClient, state: ConnectionState): void {
    if (!this.needsRecovery(state)) {
      return
    }
    this.registerActiveFailure(logical)
    this.onRetry()
  }

  needsRecovery(state: ConnectionState): boolean {
    return state !== 'connected' && state !== 'connecting' && state !== 'handshaking'
  }

  suspendActiveRelay(logical: StableLogicalRpcClient): void {
    if (logical.getActivePath() !== 'relay') {
      return
    }
    this.activeSession = null
    this.activeRelayConnectedAt = null
    logical.suspendActiveSession()
  }

  setActiveSession(session: MobileRelayRpcSession): void {
    // Why: an authenticated relay is the desktop accepting this device — the only
    // evidence that outranks a rejection streak.
    this.pairingRejection.clear()
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
    // Why: direct auth resolves the same desktop device registry, so a live direct
    // session disproves revocation even though relay is still gated.
    this.pairingRejection.clear()
    if (needsCredentialRefresh) {
      // Why: the rejected credential stays unusable until its replacement is
      // durable. No reprobe timer here — direct is live, rotation over it
      // clears the gate, and any later state failure re-arms via shouldDefer.
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
      this.pairingRejection.clear()
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

  // For callers that found no dialable credential at all: keep a slow retry
  // alive so a later durable write can recover.
  armCredentialReprobe(): void {
    if (this.credentials.hasRejected()) {
      this.holdGate(true, 'fresh-credential')
      return
    }
    if (this.recoveryGate) {
      // Why: under a held gate the tick must mint its pass token — a plain
      // cooldown tick bounces off shouldDefer and doubles the effective cadence.
      this.holdGate(true)
      return
    }
    // Why: a merely missing or expired bundle must not enter the credential
    // gate — that gate forces a rotation on the next direct connect. A plain
    // cooldown retries the read on the same escalating cadence.
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

  registerActiveFailure(logical: StableLogicalRpcClient): void {
    if (logical.getActivePath() !== 'relay') {
      return
    }
    const failure = this.activeSession?.getFailure()
    this.activeSession = null
    if (failure) {
      // Why: active relay closes need the same cooldown as failed replacement dials.
      this.registerFailure(failure)
    } else {
      this.activeRelayConnectedAt = null
    }
  }

  // True when the caller is still inside the cooldown window and must not
  // re-dial. Arms the self-scheduled retry so recovery still happens on its own.
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
    // Why: the gated early return below skips every later failure, so a revoked
    // pairing must bank its evidence first or the UI waits forever (STA-4681). A live
    // authenticated relay is the desktop accepting this device right now, so a failed
    // replacement dial is not revocation — banking it would fire a false re-pair alarm
    // the moment that healthy session drops for an unrelated transport error.
    this.pairingRejection.record(this.activeSession ? null : error)
    const code = error instanceof RelayOuterError ? error.code : null
    const recovery =
      code != null && isMobileRelayCloseCode(code)
        ? mobileRelayRecoveryFor(code, 'phone-resume')
        : null
    if (
      this.recoveryGate === 'fresh-credential' ||
      (this.recoveryGate === 'external-signal' && recovery?.kind !== 'disable-relay-credential')
    ) {
      // Why: a failed reprobe stays gated, but the slow cadence must keep going
      // — unless the supervisor is backgrounded/stopped; resume re-arms it.
      this.holdGate(scheduleRetry)
      return
    }
    const now = this.dependencies.now()
    const failureCount = this.failureCount.recordAfterConnection(this.activeRelayConnectedAt, now)
    // Why: only a stable authenticated Relay resets the failure streak.
    this.activeRelayConnectedAt = null
    const delay =
      recovery?.kind === 'retry-after-host-offline'
        ? this.delays.hostOfflineDelayMs()
        : this.delays.transportDelayMs(failureCount)
    this.nextAttemptAt = now + delay
    if (error instanceof MobileE2EEAuthenticationError) {
      // Why: an E2EE rejection is usually pairing revocation, but it also fires
      // transiently right after pairing while the desktop commits credentials —
      // reprobe slowly instead of waiting forever for a UI nudge.
      this.holdGate(scheduleRetry, 'external-signal')
      return
    }
    if (recovery?.kind === 'disable-relay-credential') {
      // Why: never redial a rejected credential fast, but keep a slow reprobe
      // alive — the caller re-reads durable state before each gated attempt.
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

  shouldTryGraceAfterRelayFailure(error: Error): boolean {
    // Why: only a rejected outer credential can be repaired by the grace token;
    // retrying session/capacity close codes immediately recreates relay churn.
    return (
      error instanceof RelayOuterError &&
      error.code === MOBILE_RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL
    )
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
      // Why: the streak advances once per fired tick — arm attempts within one
      // cycle recompute the same delay instead of triple-escalating it.
      this.gateReprobeStreak = Math.min(this.gateReprobeStreak + 1, 8)
      // Why: the tick token is only minted while its gate still holds; a later
      // gate must not spend a stale token and bypass its own cooldown.
      if (mintToken && this.recoveryGate) {
        this.gateReprobePending = true
      }
      this.onRetry()
    }, delay)
  }

  // Holds (or enters) a gate: only the slow reprobe cadence survives, and a
  // backgrounded or stopped supervisor gets no timer at all until it resumes.
  private holdGate(scheduleRetry: boolean, gate = this.recoveryGate): void {
    this.recoveryGate = gate
    this.clearTimer()
    if (scheduleRetry) {
      this.scheduleGateReprobe()
    }
  }

  // Why: clearing a gate must also drop its timer, pending tick, and cadence —
  // an orphaned reprobe timer would otherwise swallow the next fast backoff.
  private liftGate(): void {
    this.recoveryGate = null
    this.gateReprobePending = false
    this.gateReprobeStreak = 0
    this.clearTimer()
  }
}
