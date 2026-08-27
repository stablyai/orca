export type GpuCrashHistoryEntry = {
  /** Wall clock (Date.now); performance.now() restarts at 0 on every relaunch. */
  ts: number
  exitCode: number | null
  /** Launch counter that produced the crash, incremented once per launch. */
  launchSeq: number
}

/** Per-launch handle on the persisted crash ring (startup/gpu-crash-history-store). */
export type GpuCrashHistoryLaunch = {
  readonly launchSeq: number
  /** Wall clock of the last declined fallback restart on this build, if any. */
  readonly declinedAt: number | null
  /** Appends this launch's crash and returns the retained ring, oldest first. */
  append(crash: { ts: number; exitCode: number | null }): readonly GpuCrashHistoryEntry[]
  /** Starts the re-prompt cooldown after the user chose to keep running. */
  noteRestartDeclined(at: number): void
}

export type GpuCrashFallbackOptions = {
  /** Rolling span over which clustered GPU crashes indicate a broken driver. */
  windowMs: number
  /** GPU child crashes within the window that trigger software-rendering fallback. */
  threshold: number
  /** Persisted, build-scoped crash ring; omitted the tracker is in-launch only. */
  history?: GpuCrashHistoryLaunch | null
  /** Wall-clock span over which crashes from earlier launches still count. */
  crossLaunchWindowMs?: number
  /** Distinct crashing launches inside `crossLaunchWindowMs` that trigger fallback. */
  crossLaunchThreshold?: number
  /** Back-to-back launches that each saw a GPU crash and trigger fallback. */
  crashingLaunchStreak?: number
  /** Wall-clock span the whole streak must fit inside to still describe this machine. */
  crashingLaunchStreakWindowMs?: number
  /** Quiet period after the user declines the restart before prompting again. */
  declineCooldownMs?: number
}

const GPU_FALLBACK_CRASH_REASONS = new Set(['abnormal-exit', 'crashed', 'launch-failed'])

// Why: on old/flaky GPU drivers the GPU child process crashes (STATUS_BREAKPOINT
// / ANGLE-D3D init failure) repeatedly - Windows clusters F0BDNADU79Q and
// F0BDNRZ5MDG. GPU child deaths are intentionally suppressed as recoverable
// churn, so Orca never reacted. A tight burst is the signal that hardware
// acceleration is unusable on this machine.
export const DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS = 30_000
export const DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD = 3

// Why: the in-launch burst rule can never fire when the GPU fault takes the whole
// app down (F0BNM0R87SL crashes once per launch, forever), so the same evidence is
// re-evaluated across launches from the persisted ring.
export const DEFAULT_GPU_CROSS_LAUNCH_WINDOW_MS = 30 * 60_000
export const DEFAULT_GPU_CROSS_LAUNCH_THRESHOLD = 3
export const DEFAULT_GPU_CRASHING_LAUNCH_STREAK = 3
// Why: three crashing launches only describe *this* machine's driver if they
// happened around the same time; a user who opens Orca once a day fits, one who
// opens it weekly is looking at three unrelated bits of Chromium churn.
export const DEFAULT_GPU_CRASHING_LAUNCH_STREAK_WINDOW_MS = 72 * 60 * 60_000
// Why: "Keep Running" has to mean something — re-asking on the first GPU crash
// of every later launch is worse than the churn it warns about.
export const DEFAULT_GPU_FALLBACK_DECLINE_COOLDOWN_MS = 24 * 60 * 60_000

/**
 * Cross-launch verdict over the persisted ring: either enough separate launches
 * crashed inside the window, or enough back-to-back launches each died on the GPU.
 *
 * Both rules count launches, never raw crashes. Churn inside a single launch is
 * the burst rule's call, and letting extra crashes from one launch fill a looser
 * window would relaunch sessions the burst rule deliberately spares (field
 * session F0BGRN5912M: 4 recovered crashes in 74s, plus one benign crash later).
 *
 * Both rules are also wall-clock bounded. `launchSeq` gaps break the streak, but
 * a crashing launch is only evidence while it is recent — see the streak window.
 */
export function evaluateCrossLaunchGpuCrashes(
  entries: readonly GpuCrashHistoryEntry[],
  options: {
    now: number
    launchSeq: number
    windowMs: number
    threshold: number
    crashingLaunchStreak: number
    crashingLaunchStreakWindowMs: number
  }
): {
  crashesInWindow: number
  crashingLaunchesInWindow: number
  launchStreak: number
  shouldEngage: boolean
} {
  const cutoff = options.now - options.windowMs
  const inWindow = entries.filter((entry) => entry.ts >= cutoff && entry.ts <= options.now)
  const launchesInWindow = new Set(inWindow.map((entry) => entry.launchSeq))
  const streakCutoff = options.now - options.crashingLaunchStreakWindowMs
  const newestCrashPerLaunch = new Map<number, number>()
  for (const entry of entries) {
    newestCrashPerLaunch.set(
      entry.launchSeq,
      Math.max(entry.ts, newestCrashPerLaunch.get(entry.launchSeq) ?? entry.ts)
    )
  }
  let launchStreak = 0
  for (;;) {
    const newestCrash = newestCrashPerLaunch.get(options.launchSeq - launchStreak)
    if (newestCrash === undefined || newestCrash < streakCutoff) {
      break
    }
    launchStreak += 1
  }
  return {
    crashesInWindow: inWindow.length,
    crashingLaunchesInWindow: launchesInWindow.size,
    launchStreak,
    shouldEngage:
      launchesInWindow.size >= options.threshold || launchStreak >= options.crashingLaunchStreak
  }
}

/**
 * Tracks GPU child-process crashes and decides when to fall back to software
 * rendering on the next launch. Pure and deterministic: callers pass `now`
 * (ms since launch) so behavior is testable without timers.
 *
 * The window is rolling, not anchored to launch. A driver can start failing at
 * any point in a session — GPU work is demand-driven, so the first heavy
 * compositing often happens minutes in. Session 12e6ee64 hit exactly `threshold`
 * crashes inside `windowMs` (3 in 26.0s) and was ignored solely because the
 * burst began 920s after launch. What distinguishes a broken driver from normal
 * Chromium churn is that the crashes *cluster*, not when the cluster starts.
 */
export class GpuCrashFallbackTracker {
  private readonly windowMs: number
  private readonly threshold: number
  // Newest-last crash times (ms since launch), pruned to the rolling window.
  private readonly recentCrashes: number[] = []
  private readonly history: GpuCrashHistoryLaunch | null
  private readonly crossLaunchWindowMs: number
  private readonly crossLaunchThreshold: number
  private readonly crashingLaunchStreak: number
  private readonly crashingLaunchStreakWindowMs: number
  private readonly declineCooldownMs: number
  private engaged = false

  constructor(options: GpuCrashFallbackOptions) {
    this.windowMs = options.windowMs
    this.threshold = options.threshold
    this.history = options.history ?? null
    this.crossLaunchWindowMs = options.crossLaunchWindowMs ?? DEFAULT_GPU_CROSS_LAUNCH_WINDOW_MS
    this.crossLaunchThreshold = options.crossLaunchThreshold ?? DEFAULT_GPU_CROSS_LAUNCH_THRESHOLD
    this.crashingLaunchStreak = options.crashingLaunchStreak ?? DEFAULT_GPU_CRASHING_LAUNCH_STREAK
    this.crashingLaunchStreakWindowMs =
      options.crashingLaunchStreakWindowMs ?? DEFAULT_GPU_CRASHING_LAUNCH_STREAK_WINDOW_MS
    this.declineCooldownMs = options.declineCooldownMs ?? DEFAULT_GPU_FALLBACK_DECLINE_COOLDOWN_MS
  }

  /**
   * Records a GPU child crash at `msSinceLaunch` and reports whether this crash
   * just pushed the count over the threshold (i.e. fallback should engage now).
   * Returns false after fallback already engaged, so the caller relaunches at
   * most once.
   */
  recordGpuCrash(
    msSinceLaunch: number,
    crash: { at?: number; exitCode?: number | null } = {}
  ): {
    shouldEngageFallback: boolean
    crashesInWindow: number
  } {
    if (this.engaged || !Number.isFinite(msSinceLaunch) || msSinceLaunch < 0) {
      return { shouldEngageFallback: false, crashesInWindow: this.recentCrashes.length }
    }
    // Why: out-of-order arrivals would corrupt the sorted window, and a clock
    // that jumps backwards must not resurrect crashes already pruned.
    const at = Math.max(msSinceLaunch, this.recentCrashes.at(-1) ?? 0)
    this.recentCrashes.push(at)
    const cutoff = at - this.windowMs
    let stale = 0
    while (stale < this.recentCrashes.length && this.recentCrashes[stale] < cutoff) {
      stale += 1
    }
    this.recentCrashes.splice(0, stale)
    const wallClock = crash.at ?? Date.now()
    // Evidence keeps accruing through the cooldown so the next prompt sees the truth.
    const persisted = this.history?.append({ ts: wallClock, exitCode: crash.exitCode ?? null })
    if (this.isWithinDeclineCooldown(wallClock)) {
      return { shouldEngageFallback: false, crashesInWindow: this.recentCrashes.length }
    }
    if (this.recentCrashes.length >= this.threshold) {
      this.engaged = true
      return { shouldEngageFallback: true, crashesInWindow: this.recentCrashes.length }
    }
    if (persisted && this.history) {
      const crossLaunch = evaluateCrossLaunchGpuCrashes(persisted, {
        now: wallClock,
        launchSeq: this.history.launchSeq,
        windowMs: this.crossLaunchWindowMs,
        threshold: this.crossLaunchThreshold,
        crashingLaunchStreak: this.crashingLaunchStreak,
        crashingLaunchStreakWindowMs: this.crashingLaunchStreakWindowMs
      })
      if (crossLaunch.shouldEngage) {
        this.engaged = true
        return { shouldEngageFallback: true, crashesInWindow: crossLaunch.crashesInWindow }
      }
    }
    return { shouldEngageFallback: false, crashesInWindow: this.recentCrashes.length }
  }

  hasEngaged(): boolean {
    return this.engaged
  }

  // Why |Δ|: a clock stepped backwards past the decline must not pin the prompt
  // off forever — asking once too often beats never asking again.
  private isWithinDeclineCooldown(wallClock: number): boolean {
    const declinedAt = this.history?.declinedAt ?? null
    return declinedAt !== null && Math.abs(wallClock - declinedAt) < this.declineCooldownMs
  }

  /** Crash times currently inside the window. Exposed to assert the pruning invariant. */
  windowSnapshot(): readonly number[] {
    return [...this.recentCrashes]
  }
}

/** True for the Chromium child process types whose crashes should count here. */
export function isGpuChildProcessType(processType: string | undefined): boolean {
  return (processType ?? '').toLowerCase() === 'gpu'
}

export function isGpuFallbackCrashCandidate({
  platform,
  processType,
  reason
}: {
  platform: NodeJS.Platform
  processType: string | undefined
  reason: string
}): boolean {
  return (
    platform === 'win32' &&
    isGpuChildProcessType(processType) &&
    GPU_FALLBACK_CRASH_REASONS.has(reason)
  )
}
