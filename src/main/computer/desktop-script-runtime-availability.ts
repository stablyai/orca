import {
  FALLBACK_WINDOWS_EXECUTION_POLICY,
  PREFERRED_WINDOWS_EXECUTION_POLICY,
  type WindowsExecutionPolicy
} from './windows-powershell-execution-policy'

/** Retry after cooldown so transient startup failures do not permanently force one-shot calls. */
export const MAX_START_ATTEMPTS = 3
export const START_FAILURE_COOLDOWN_MS = 60_000

/** Wall-clock corrections must not extend the cooldown. */
const monotonicNowMs = (): number => performance.now()

export class RuntimeHostAvailability {
  private policy: WindowsExecutionPolicy = PREFERRED_WINDOWS_EXECUTION_POLICY
  private retryUnderFallbackPolicy = false
  private consecutiveFailures = 0
  private consecutiveSuccesses = 0
  /** Null, not 0, for "no cooldown": `performance.now()` legitimately returns 0. */
  private cooldownStartedAtMs: number | null = null
  /** Revert unproven Bypass: AppLocker/WDAC can resemble policy blocks that Bypass cannot fix. */
  private fallbackPolicyUnproven = false

  constructor(
    private readonly cooldownMs: number,
    readonly warn: (message: string) => void,
    /** Injected clocks must be monotonic. */
    private readonly now: () => number = monotonicNowMs
  ) {}

  get executionPolicy(): WindowsExecutionPolicy {
    return this.policy
  }

  get policyRetryPending(): boolean {
    return this.retryUnderFallbackPolicy
  }

  get atPreferredPolicy(): boolean {
    return this.policy === PREFERRED_WINDOWS_EXECUTION_POLICY
  }

  /** Milliseconds left before the host may try a helper again; 0 when it may. */
  remainingCooldown(): number {
    if (this.cooldownStartedAtMs === null) {
      return 0
    }
    return Math.max(0, Math.ceil(this.cooldownMs - (this.now() - this.cooldownStartedAtMs)))
  }

  requestPolicyRetry(): void {
    this.retryUnderFallbackPolicy = true
  }

  escalateExecutionPolicy(): void {
    this.retryUnderFallbackPolicy = false
    this.policy = FALLBACK_WINDOWS_EXECUTION_POLICY
    this.fallbackPolicyUnproven = true
    this.warn(
      `runtime host start blocked at ${PREFERRED_WINDOWS_EXECUTION_POLICY}; trying ${FALLBACK_WINDOWS_EXECUTION_POLICY}`
    )
  }

  confirmExecutionPolicy(): void {
    this.fallbackPolicyUnproven = false
  }

  /** Revert to the preferred policy if the fallback never starts a helper. */
  abandonUnprovenFallback(): void {
    if (!this.fallbackPolicyUnproven) {
      return
    }
    this.fallbackPolicyUnproven = false
    this.policy = PREFERRED_WINDOWS_EXECUTION_POLICY
    this.warn(
      `${FALLBACK_WINDOWS_EXECUTION_POLICY} did not start a helper either, so the execution policy was not the cause; returning to ${PREFERRED_WINDOWS_EXECUTION_POLICY}`
    )
  }

  recordFailure(): void {
    this.consecutiveSuccesses = 0
    this.consecutiveFailures++
  }

  get exhausted(): boolean {
    return this.consecutiveFailures >= MAX_START_ATTEMPTS
  }

  recordSuccess(): void {
    this.consecutiveSuccesses++
    this.fallbackPolicyUnproven = false
    // Require consecutive successes so alternating replies and crashes cannot reset the failure count.
    if (this.consecutiveSuccesses >= MAX_START_ATTEMPTS) {
      this.consecutiveFailures = 0
    }
    if (this.cooldownStartedAtMs === null) {
      return
    }
    this.cooldownStartedAtMs = null
    this.warn('runtime host recovered; operations are served by the persistent helper again')
  }

  enterCooldown(): void {
    this.abandonUnprovenFallback()
    const failures = this.consecutiveFailures
    this.cooldownStartedAtMs = this.now()
    // Cooldown already paid for this outage; recovery starts with a fresh failure count.
    this.consecutiveFailures = 0
    this.consecutiveSuccesses = 0
    this.warn(
      `runtime host unavailable after ${failures} consecutive failures; falling back to one powershell.exe per operation for ${this.cooldownMs}ms`
    )
  }

  clearCooldown(): void {
    this.cooldownStartedAtMs = null
  }
}
