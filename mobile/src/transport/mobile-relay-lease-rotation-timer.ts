import type { ScheduleTimer } from './timer-scheduler'

// Refresh resume credentials before expiry and retry missed rotations through one timer slot.
const LEASE_ROTATION_MARGIN_MS = 30_000
// Clamp both ends: the floor prevents rotation churn and the ceiling avoids setTimeout int32 overflow on long leases.
const LEASE_ROTATION_MIN_DELAY_MS = 60_000
const LEASE_ROTATION_MAX_DELAY_MS = 6 * 60 * 60 * 1000

export type RelayLeaseRotationDependencies = {
  now: () => number
  setTimer: ScheduleTimer
  clearTimer: typeof clearTimeout
}

export class RelayLeaseRotationTimer {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly dependencies: RelayLeaseRotationDependencies,
    private readonly onRotate: () => void
  ) {}

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

  // Keep one retry timer after missed rotation; ignore requests while one is pending.
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
