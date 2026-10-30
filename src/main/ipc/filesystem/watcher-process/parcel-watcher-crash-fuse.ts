const CRASH_WINDOW_MS = 2 * 60_000
const MAX_CRASHES_PER_WINDOW = 3
export const CRASH_FUSE_COOLDOWN_INITIAL_MS = 5 * 60_000
export const CRASH_FUSE_COOLDOWN_MAX_MS = 60 * 60_000
// A trial child whose canary confirms delivery this long resets the escalation.
export const CRASH_FUSE_TRIAL_STABLE_MS = 10 * 60_000

/** Retry native watching after exponential cooldown; callers need their own polling while the fuse is open. */
export class WatcherProcessCrashFuse {
  private crashTimes: number[] = []
  private openUntil: number | null = null
  private trialStartedAt: number | null = null
  private healthySince: number | null = null
  private trips = 0

  recordCrash(now = Date.now()): void {
    this.settle(now)
    if (this.openUntil !== null) {
      return
    }
    // A failed trial trips immediately instead of spending three more restarts.
    if (this.trialStartedAt !== null) {
      this.trip(now)
      return
    }
    this.crashTimes.push(now)
    if (this.crashTimes.length >= MAX_CRASHES_PER_WINDOW) {
      this.trip(now)
    }
  }

  isOpen(now = Date.now()): boolean {
    this.settle(now)
    return this.openUntil !== null
  }

  /** A new child has not proven delivery yet. */
  noteChildStarted(): void {
    this.healthySince = null
  }

  recordDeliveryHealth(state: 'healthy' | 'stalled' | 'unknown', now = Date.now()): void {
    this.settle(now)
    if (state === 'stalled') {
      this.healthySince = null
    } else if (state === 'healthy') {
      this.healthySince ??= now
    }
  }

  reset(): void {
    this.crashTimes = []
    this.openUntil = null
    this.trialStartedAt = null
    this.healthySince = null
    this.trips = 0
  }

  private trip(now: number): void {
    const cooldownMs = Math.min(
      CRASH_FUSE_COOLDOWN_INITIAL_MS * 2 ** this.trips,
      CRASH_FUSE_COOLDOWN_MAX_MS
    )
    this.trips++
    this.openUntil = now + cooldownMs
    this.trialStartedAt = null
    this.healthySince = null
    this.crashTimes = []
    console.error(
      `[parcel-watcher-process] crash fuse open; native file watching paused for ${Math.round(cooldownMs / 1000)}s`
    )
  }

  private settle(now: number): void {
    if (this.openUntil !== null && now >= this.openUntil) {
      this.openUntil = null
      this.trialStartedAt = now
      this.healthySince = null
      console.warn(
        '[parcel-watcher-process] crash fuse cooldown elapsed; retrying native file watching'
      )
    }
    // Survival alone is insufficient: an unarmed or silent canary has not proved recovery.
    if (
      this.trialStartedAt !== null &&
      this.healthySince !== null &&
      now - this.healthySince >= CRASH_FUSE_TRIAL_STABLE_MS
    ) {
      this.trialStartedAt = null
      this.trips = 0
    }
    this.crashTimes = this.crashTimes.filter((time) => now - time < CRASH_WINDOW_MS)
  }
}
