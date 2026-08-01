export type GpuCrashFallbackOptions = {
  /** Rolling span over which clustered GPU crashes indicate a broken driver. */
  windowMs: number
  /** GPU child crashes within the window that trigger software-rendering fallback. */
  threshold: number
}

const GPU_FALLBACK_CRASH_REASONS = new Set(['abnormal-exit', 'crashed', 'launch-failed'])

/**
 * Reasons that may accumulate in the *cross-launch* history.
 *
 * Why `launch-failed` is excluded here but kept in-process: a GPU that fails to
 * launch clusters across launches for recoverable reasons — a driver update in
 * flight, an RDP session transition, a monitor hotplug — and durable counting
 * would latch build-sticky safe graphics on a condition that clears itself. Three
 * launch failures inside one 30s session is still a broken GPU, so the in-process
 * tracker keeps counting them.
 *
 * Costs nothing on the observed data: the 39 cluster-E bundles hold 111 distinct
 * GPU child deaths — 97 `crashed` (87 STATUS_BREAKPOINT, 9 exit-34, 1 exit-`-1`),
 * 14 `killed` (13 exit-1), and zero `launch-failed`. `killed` reaches neither
 * counter, here or in `GPU_FALLBACK_CRASH_REASONS`; that predates this file.
 */
const DURABLE_GPU_FALLBACK_CRASH_REASONS = new Set(['abnormal-exit', 'crashed'])

export function countsTowardDurableGpuCrashHistory(reason: string): boolean {
  return DURABLE_GPU_FALLBACK_CRASH_REASONS.has(reason)
}

// Why: on old/flaky GPU drivers the GPU child process crashes (STATUS_BREAKPOINT
// / ANGLE-D3D init failure) repeatedly - Windows clusters F0BDNADU79Q and
// F0BDNRZ5MDG. GPU child deaths are intentionally suppressed as recoverable
// churn, so Orca never reacted. A tight burst is the signal that hardware
// acceleration is unusable on this machine.
export const DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS = 30_000
export const DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD = 3

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
  private engaged = false

  constructor(options: GpuCrashFallbackOptions) {
    this.windowMs = options.windowMs
    this.threshold = options.threshold
  }

  /**
   * Records a GPU child crash at `msSinceLaunch` and reports whether this crash
   * just pushed the count over the threshold (i.e. fallback should engage now).
   * Returns false after fallback already engaged, so the caller relaunches at
   * most once.
   */
  recordGpuCrash(msSinceLaunch: number): {
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
    if (this.recentCrashes.length >= this.threshold) {
      this.engaged = true
      return { shouldEngageFallback: true, crashesInWindow: this.recentCrashes.length }
    }
    return { shouldEngageFallback: false, crashesInWindow: this.recentCrashes.length }
  }

  hasEngaged(): boolean {
    return this.engaged
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
