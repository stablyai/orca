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
  private readonly rejectedCredentialVersions = new Set<number>()

  constructor(
    private readonly dependencies: RelayReconnectDependencies,
    private readonly onRetry: (forceReplacement?: boolean) => void
  ) {}

  handleForeground(logical: StableLogicalRpcClient, wasForeground: boolean): void {
    if (!wasForeground) {
      // Why: an app resume is a fresh signal, unlike repeated network-flap nudges.
      if (this.recoveryGate !== 'fresh-credential') {
        this.reset()
      }
    } else if (this.recoveryGate === 'external-signal') {
      this.recoveryGate = null
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
    this.recoveryGate = null
    this.clearTimer()
  }

  resetForDirectConnection(): boolean {
    const needsCredentialRefresh =
      this.recoveryGate === 'fresh-credential' || this.rejectedCredentialVersions.size > 0
    this.activeSession = null
    this.activeRelayConnectedAt = null
    if (needsCredentialRefresh) {
      // Why: the rejected credential stays unusable until its replacement is durable.
      this.consecutiveFailures = 0
      this.nextAttemptAt = 0
      this.recoveryGate = 'fresh-credential'
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
    }
    return eligible
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
      // Why: only the gate's external signal can make a known-fatal recovery retryable.
      this.clearTimer()
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
    const delay = this.delayMs()
    this.nextAttemptAt = now + delay
    if (error instanceof MobileE2EEAuthenticationError) {
      // Why: pairing state cannot change on a timer; polling only wakes the radio.
      this.recoveryGate = 'external-signal'
      this.clearTimer()
      return
    }
    if (recovery?.kind === 'wait-for-host-revival') {
      // Why: retrying HOST_OFFLINE without a revival signal is polling a known-negative state.
      this.recoveryGate = 'external-signal'
      this.clearTimer()
      return
    }
    if (recovery?.kind === 'disable-relay-credential') {
      // Why: a rejected outer credential cannot recover until direct connectivity refreshes it.
      this.recoveryGate = 'fresh-credential'
      this.clearTimer()
      return
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
    this.recoveryGate = null
    this.clearTimer()
  }

  clear(): void {
    this.clearTimer()
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

  private delayMs(): number {
    const exponent = Math.max(0, this.consecutiveFailures - 1)
    const cap = Math.min(RELAY_BACKOFF_CEILING_MS, RELAY_BACKOFF_BASE_MS * 2 ** exponent)
    // Full jitter (uniform in [0, cap)), floored so retries never busy-loop.
    return Math.max(RELAY_BACKOFF_MIN_MS, Math.floor(cap * this.jitterFraction()))
  }

  private jitterFraction(): number {
    const [high, low] = this.dependencies.randomBytes(2)
    return (((high ?? 0) << 8) | (low ?? 0)) / 0x1_00_00
  }
}
