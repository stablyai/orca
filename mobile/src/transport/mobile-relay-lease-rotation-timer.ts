// Why: the relay resume lease expires; the phone must proactively re-resume a
// little before the deadline (and retry shortly if a forced rotation didn't land)
// so the session never lapses. Owns the single lease/rotation timer slot.
const LEASE_ROTATION_MARGIN_MS = 30_000

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
    const delay = Math.max(
      1000,
      leaseExpiresAt - this.dependencies.now() - LEASE_ROTATION_MARGIN_MS
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
