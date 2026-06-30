export type GpuCrashFallbackOptions = {
  /** Window after launch in which clustered GPU crashes indicate a broken driver. */
  windowMs: number
  /** GPU child crashes within the window that trigger software-rendering fallback. */
  threshold: number
}

const GPU_FALLBACK_CRASH_REASONS = new Set(['abnormal-exit', 'crashed', 'launch-failed'])

// Why: on old/flaky GPU drivers the GPU child process crashes (STATUS_BREAKPOINT
// / ANGLE-D3D init failure) within seconds of launch, repeatedly - Windows
// clusters F0BDNADU79Q and F0BDNRZ5MDG. GPU child deaths are intentionally
// suppressed as recoverable churn, so Orca never reacted. A burst right after
// launch is the signal that hardware acceleration is unusable on this machine.
export const DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS = 30_000
export const DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD = 3

/**
 * Tracks GPU child-process crashes relative to launch and decides when to fall
 * back to software rendering on the next launch. Pure and deterministic:
 * callers pass `now` (ms since launch) so behavior is testable without timers.
 *
 * Only crashes inside the post-launch window count: a one-off GPU hiccup hours
 * into a session is normal Chromium churn, not a broken-driver signal.
 */
export class GpuCrashFallbackTracker {
  private readonly windowMs: number
  private readonly threshold: number
  private crashesInWindow = 0
  private engaged = false

  constructor(options: GpuCrashFallbackOptions) {
    this.windowMs = options.windowMs
    this.threshold = options.threshold
  }

  /**
   * Records a GPU child crash at `msSinceLaunch` and reports whether this crash
   * just pushed the count over the threshold (i.e. fallback should engage now).
   * Returns false for crashes outside the window or after fallback already
   * engaged, so the caller relaunches at most once.
   */
  recordGpuCrash(msSinceLaunch: number): {
    shouldEngageFallback: boolean
    crashesInWindow: number
  } {
    if (
      this.engaged ||
      !Number.isFinite(msSinceLaunch) ||
      msSinceLaunch < 0 ||
      msSinceLaunch > this.windowMs
    ) {
      return { shouldEngageFallback: false, crashesInWindow: this.crashesInWindow }
    }
    this.crashesInWindow += 1
    if (this.crashesInWindow >= this.threshold) {
      this.engaged = true
      return { shouldEngageFallback: true, crashesInWindow: this.crashesInWindow }
    }
    return { shouldEngageFallback: false, crashesInWindow: this.crashesInWindow }
  }

  hasEngaged(): boolean {
    return this.engaged
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
