// Why: the relay resume lease expires; the phone must proactively re-resume a
// little before the deadline (and retry shortly if a forced rotation didn't land)
// so the session never lapses. Owns the single lease/rotation timer slot.
const LEASE_ROTATION_MARGIN_MS = 30_000
// Why: both ends must be clamped. The floor bounds any bad deadline to one
// forced rotation per minute instead of a sub-second loop; the ceiling keeps
// the delay far below setTimeout's 32-bit limit (a 30-day resume TTL minus the
// margin overflows int32 and fires at 1ms), at the cost of a harmless
// re-resume every few hours on long-lived sessions.
const LEASE_ROTATION_MIN_DELAY_MS = 60_000
const LEASE_ROTATION_MAX_DELAY_MS = 6 * 60 * 60 * 1000

export type RelayLeaseRotationDependencies = {
  now: () => number
  setTimer: typeof setTimeout
  clearTimer: typeof clearTimeout
}

export class RelayLeaseRotationTimer {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly dependencies: RelayLeaseRotationDependencies,
    private readonly onRotate: () => void
  ) {}

  // Arm rotation a margin before the lease deadline. No-op with no deadline.
  scheduleFromLease(leaseExpiresAt: number | null): void {
    this.clear()
    if (!leaseExpiresAt) {
      return
    }
    const delay = Math.min(
      LEASE_ROTATION_MAX_DELAY_MS,
      Math.max(
        LEASE_ROTATION_MIN_DELAY_MS,
        leaseExpiresAt - this.dependencies.now() - LEASE_ROTATION_MARGIN_MS
      )
    )
    this.arm(delay)
  }

  // Re-arm a short retry when a forced rotation's recovery did not complete.
  // Ignored while a timer is already pending so retries never stack.
  armRetry(delayMs: number | null): void {
    if (delayMs == null || this.timer) {
      return
    }
    this.arm(delayMs)
  }

  get pending(): boolean {
    return this.timer != null
  }

  clear(): void {
    if (this.timer) {
      this.dependencies.clearTimer(this.timer)
      this.timer = null
    }
  }

  private arm(delayMs: number): void {
    this.timer = this.dependencies.setTimer(() => {
      this.timer = null
      this.onRotate()
    }, delayMs)
  }
}
