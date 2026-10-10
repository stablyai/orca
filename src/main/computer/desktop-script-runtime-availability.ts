import {
  FALLBACK_WINDOWS_EXECUTION_POLICY,
  PREFERRED_WINDOWS_EXECUTION_POLICY,
  type WindowsExecutionPolicy
} from './windows-powershell-execution-policy'

/**
 * Consecutive child failures before the helper is believed dead, and how long
 * the one-shot bridge covers for it afterwards.
 *
 * Why not a latch: every plausible cause is transient — a Defender scan touching
 * the script mid-launch, a locked CSC temp directory failing one `Add-Type`,
 * momentary memory pressure. Giving up permanently silently restores the
 * per-click process burst the host exists to remove, and computer use keeps
 * working throughout, so nothing looks wrong while the MDE signature returns.
 */
export const MAX_START_ATTEMPTS = 3
export const START_FAILURE_COOLDOWN_MS = 60_000

/**
 * Why not `Date.now`: an NTP correction, a VM snapshot restore or a user changing
 * the clock steps the wall clock backwards, which extended the cooldown by the
 * size of the step. Nothing shortens it from there — only `recordSuccess` clears
 * it, and no request can reach a helper to succeed while it holds — so a one-hour
 * step disabled the persistent helper for the life of the sidecar, silently
 * restoring the per-click process burst. Elapsed monotonic time cannot go
 * backwards.
 */
const monotonicNowMs = (): number => performance.now()

/**
 * Whether the persistent helper is currently believed usable, and the execution
 * policy it should be started under.
 *
 * Split from the host so the recovery rules are readable on their own: they are
 * what stands between a transient bad spawn and a session that silently spends
 * the rest of its life on one powershell.exe per click.
 */
export class RuntimeHostAvailability {
  private policy: WindowsExecutionPolicy = PREFERRED_WINDOWS_EXECUTION_POLICY
  private retryUnderFallbackPolicy = false
  private consecutiveFailures = 0
  private consecutiveSuccesses = 0
  /** Null, not 0, for "no cooldown": `performance.now()` legitimately returns 0. */
  private cooldownStartedAtMs: number | null = null
  /**
   * Set while the escalated policy has yet to start a helper, so a wrong
   * diagnosis can be taken back.
   *
   * Why it can be wrong: AppLocker and WDAC constrained language mode raise
   * PSSecurityException under the same SecurityError category a policy block
   * uses, but they refuse the script at parse time, which `Bypass` cannot lift.
   * Latching there would spend the session putting the most heavily weighted
   * MDE token on every command line, on exactly the hardened hosts watching
   * for it.
   */
  private fallbackPolicyUnproven = false

  constructor(
    private readonly cooldownMs: number,
    /** Public so the host can report its own start attempts to the same sink. */
    readonly warn: (message: string) => void,
    /** Overridden only by tests; the default must stay monotonic. */
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
    // Elapsed since the cooldown began, never a stored deadline: a deadline is
    // only as trustworthy as the clock it was computed against.
    return Math.max(0, Math.ceil(this.cooldownMs - (this.now() - this.cooldownStartedAtMs)))
  }

  requestPolicyRetry(): void {
    this.retryUnderFallbackPolicy = true
  }

  escalateExecutionPolicy(): void {
    this.retryUnderFallbackPolicy = false
    this.policy = FALLBACK_WINDOWS_EXECUTION_POLICY
    this.fallbackPolicyUnproven = true
    // Sticky once proven: a genuinely Restricted machine would otherwise pay a
    // guaranteed failed spawn per operation. Only a helper that produced no
    // output at all can reach here, so a snapshot cannot talk the host into it.
    this.warn(
      `runtime host start blocked at ${PREFERRED_WINDOWS_EXECUTION_POLICY}; trying ${FALLBACK_WINDOWS_EXECUTION_POLICY}`
    )
  }

  /** A helper started under the current policy, so the policy is the right one. */
  confirmExecutionPolicy(): void {
    this.fallbackPolicyUnproven = false
  }

  /**
   * Undo an escalation the fallback never justified.
   *
   * The escalation is a diagnosis, and a fallback that cannot start a helper
   * either disproves it: the policy was not what stopped the first attempt. Go
   * back rather than latch, so a re-probe can escalate again later if the real
   * cause clears. Re-probing costs one spawn per outage, which the failure
   * count and its cooldown already bound, and never latching is the whole point
   * of this class.
   */
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

  /** True once a helper has died often enough that respawning is just thrash. */
  get exhausted(): boolean {
    return this.consecutiveFailures >= MAX_START_ATTEMPTS
  }

  recordSuccess(): void {
    this.consecutiveSuccesses++
    this.fallbackPolicyUnproven = false
    // Why a clean run and not a single reply: a helper that answers one
    // operation and dies on the next would otherwise reset the count forever,
    // and respawn once per operation — the exact burst the host removes.
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
    // An escalation that never started a helper must not outlive the outage it
    // was guessed from; the next one re-diagnoses from the preferred policy.
    this.abandonUnprovenFallback()
    const failures = this.consecutiveFailures
    this.cooldownStartedAtMs = this.now()
    // The wait is the penalty; leaving the count at the limit would charge twice
    // and let the first death after recovery re-enter a full cooldown, so an
    // interleaved workload would spend its life on the one-shot bridge.
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
