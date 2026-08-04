import {
  isMobileRelayCloseCode,
  MOBILE_RELAY_CLOSE_CODE,
  mobileRelayRecoveryFor
} from '../../../src/shared/mobile-relay-close-codes'
import type { MobileRelayRpcSession } from './mobile-relay-rpc-session'
import { MobileE2EEAuthenticationError } from './mobile-e2ee-v2-physical-channel'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionState } from './types'

// Why: relay resume closes and silent cellular NAT rebinds otherwise cause
// immediate re-dials that ping-pong the phone between connected and disconnected.
const RELAY_BACKOFF_MIN_MS = 250
const RELAY_BACKOFF_BASE_MS = 500
const RELAY_BACKOFF_CEILING_MS = 30_000
const RELAY_STABLE_CONNECTION_MS = RELAY_BACKOFF_CEILING_MS
const RELAY_HOST_OFFLINE_RETRY_MIN_MS = 5_000
const RELAY_HOST_OFFLINE_RETRY_MAX_MS = 15_000
// Why: gates must slow recovery down, never end it — a relay-only phone has no
// direct path to refresh credentials, so a timerless gate is a permanent outage.
// The cadence escalates and jitters so a permanently revoked device is not a
// forever one-minute beacon and a fleet-wide gating event cannot phase-align.
const RELAY_GATE_REPROBE_BASE_MS = 60_000
const RELAY_GATE_REPROBE_CEILING_MS = 15 * 60_000

export type RelayReconnectDependencies = {
  now: () => number
  randomBytes: (length: number) => Uint8Array
  setTimer: typeof setTimeout
  clearTimer: typeof clearTimeout
}

type RecoveryGate = 'external-signal' | 'fresh-credential'

export class RelayReconnectController {
  private consecutiveFailures = 0
  private activeRelayConnectedAt: number | null = null
  private nextAttemptAt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private activeSession: MobileRelayRpcSession | null = null
  private recoveryGate: RecoveryGate | null = null
  private gateReprobePending = false
  private gateReprobeStreak = 0
  private readonly rejectedCredentialVersions = new Set<number>()

  constructor(
    private readonly dependencies: RelayReconnectDependencies,
    private readonly onRetry: (forceReplacement?: boolean) => void
  ) {}

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
    if (
      wasForeground &&
      this.recoveryGate !== 'fresh-credential' &&
      logical.getState() === 'connected'
    ) {
      // Why: a network handoff can leave the relay half-open without publishing a close.
      this.suspendActiveRelay(logical)
    }
    // Why: revival nudges must honor failure cooldowns even when lease rotation is pending.
    this.onRetry()
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
    this.activeSession = session
    this.activeRelayConnectedAt = this.dependencies.now()
    this.nextAttemptAt = 0
    this.liftGate()
  }

  resetForDirectConnection(): boolean {
    const needsCredentialRefresh =
      this.recoveryGate === 'fresh-credential' || this.rejectedCredentialVersions.size > 0
    this.activeSession = null
    this.activeRelayConnectedAt = null
    if (needsCredentialRefresh) {
      // Why: the rejected credential stays unusable until its replacement is
      // durable. No reprobe timer here — direct is live, rotation over it
      // clears the gate, and any later state failure re-arms via shouldDefer.
      this.consecutiveFailures = 0
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
      this.rejectedCredentialVersions.clear()
      this.reset()
    }
  }

  eligibleCredentials<T extends { expiresAt: number; version: number }>(
    ...credentials: Array<T | null | undefined>
  ): T[] {
    const eligible = credentials.filter((credential): credential is T =>
      Boolean(
        credential &&
        credential.expiresAt > this.dependencies.now() &&
        !this.rejectedCredentialVersions.has(credential.version)
      )
    )
    if (eligible.length === 0 && this.rejectedCredentialVersions.size > 0) {
      this.recoveryGate = 'fresh-credential'
      this.clearTimer()
      this.scheduleGateReprobe()
    }
    return eligible
  }

  // For callers that found no dialable credential at all: keep a slow retry
  // alive so a later durable write can recover.
  armCredentialReprobe(): void {
    if (this.rejectedCredentialVersions.size > 0) {
      this.recoveryGate = 'fresh-credential'
      this.clearTimer()
      this.scheduleGateReprobe()
      return
    }
    // Why: a merely missing or expired bundle must not enter the credential
    // gate — that gate forces a rotation on the next direct connect. A plain
    // cooldown retries the read on the same escalating cadence.
    const delay = this.gateReprobeDelayMs()
    this.nextAttemptAt = this.dependencies.now() + delay
    this.clearTimer()
    this.scheduleReprobeTick(delay, false)
  }

  // A durable bundle whose current version is not rejected reopens the gate.
  acceptFreshCredential(version: number): void {
    if (this.recoveryGate === 'fresh-credential' && !this.rejectedCredentialVersions.has(version)) {
      this.liftGate()
    }
  }

  recordRejectedCredential(version: number): void {
    this.rejectedCredentialVersions.add(version)
  }

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
    const code = error instanceof RelayOuterError ? error.code : null
    const recovery =
      code != null && isMobileRelayCloseCode(code)
        ? mobileRelayRecoveryFor(code, 'phone-resume')
        : null
    if (
      this.recoveryGate === 'fresh-credential' ||
      (this.recoveryGate === 'external-signal' && recovery?.kind !== 'disable-relay-credential')
    ) {
      // Why: a failed reprobe stays gated, but the slow cadence must keep going.
      this.clearTimer()
      this.scheduleGateReprobe()
      return
    }
    const now = this.dependencies.now()
    if (
      this.activeRelayConnectedAt != null &&
      now - this.activeRelayConnectedAt >= RELAY_STABLE_CONNECTION_MS
    ) {
      this.consecutiveFailures = 0
    }
    // Why: elapsed time inside a slow failed dial is not evidence of recovery;
    // only an authenticated relay that survived the stability window resets the streak.
    this.activeRelayConnectedAt = null
    this.consecutiveFailures += 1
    const delay =
      recovery?.kind === 'retry-after-host-offline' ? this.hostOfflineDelayMs() : this.delayMs()
    this.nextAttemptAt = now + delay
    if (error instanceof MobileE2EEAuthenticationError) {
      // Why: an E2EE rejection is usually pairing revocation, but it also fires
      // transiently right after pairing while the desktop commits credentials —
      // reprobe slowly instead of waiting forever for a UI nudge.
      this.recoveryGate = 'external-signal'
      this.clearTimer()
      this.scheduleGateReprobe()
      return
    }
    if (recovery?.kind === 'disable-relay-credential') {
      // Why: never redial a rejected credential fast, but keep a slow reprobe
      // alive — the caller re-reads durable state before each gated attempt.
      this.recoveryGate = 'fresh-credential'
      this.clearTimer()
      this.scheduleGateReprobe()
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
    this.consecutiveFailures = 0
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
    this.scheduleReprobeTick(this.gateReprobeDelayMs(), true)
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

  private gateReprobeDelayMs(): number {
    const base = Math.min(
      RELAY_GATE_REPROBE_CEILING_MS,
      RELAY_GATE_REPROBE_BASE_MS * 2 ** Math.min(this.gateReprobeStreak, 8)
    )
    return Math.floor(base * (0.75 + 0.5 * this.jitterFraction()))
  }

  // Why: clearing a gate must also drop its timer, pending tick, and cadence —
  // an orphaned reprobe timer would otherwise swallow the next fast backoff.
  private liftGate(): void {
    this.recoveryGate = null
    this.gateReprobePending = false
    this.gateReprobeStreak = 0
    this.clearTimer()
  }

  private delayMs(): number {
    const exponent = Math.max(0, this.consecutiveFailures - 1)
    const cap = Math.min(RELAY_BACKOFF_CEILING_MS, RELAY_BACKOFF_BASE_MS * 2 ** exponent)
    // Full jitter (uniform in [0, cap)), floored so retries never busy-loop.
    return Math.max(RELAY_BACKOFF_MIN_MS, Math.floor(cap * this.jitterFraction()))
  }

  private hostOfflineDelayMs(): number {
    const range = RELAY_HOST_OFFLINE_RETRY_MAX_MS - RELAY_HOST_OFFLINE_RETRY_MIN_MS
    return RELAY_HOST_OFFLINE_RETRY_MIN_MS + Math.floor(range * this.jitterFraction())
  }

  private jitterFraction(): number {
    const [high, low] = this.dependencies.randomBytes(2)
    return (((high ?? 0) << 8) | (low ?? 0)) / 0x1_00_00
  }
}
