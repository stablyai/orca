export type GpuCrashFallbackOptions = {
  /** Rolling window in milliseconds; bursts can begin at any point in a session. */
  windowMs: number
  threshold: number
}

const GPU_FALLBACK_CRASH_REASONS = new Set(['abnormal-exit', 'crashed', 'launch-failed'])

export const DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS = 30_000
export const DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD = 3

export class GpuCrashFallbackTracker {
  private readonly windowMs: number
  private readonly threshold: number
  // Keep crash times sorted for prefix pruning of the rolling window.
  private readonly recentCrashes: number[] = []
  private engaged = false

  constructor(options: GpuCrashFallbackOptions) {
    this.windowMs = options.windowMs
    this.threshold = options.threshold
  }

  /** Reports each threshold crossing once until disengage() re-arms the tracker. */
  recordGpuCrash(msSinceLaunch: number): {
    shouldEngageFallback: boolean
    crashesInWindow: number
  } {
    if (this.engaged || !Number.isFinite(msSinceLaunch) || msSinceLaunch < 0) {
      // Engaged crashes are ignored, so the reported count can understate the burst.
      return { shouldEngageFallback: false, crashesInWindow: this.recentCrashes.length }
    }
    // Clamp backward jumps to preserve sorted pruning without reviving expired crashes.
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

  /** Re-arm after a declined engagement, preserving the current crash window. */
  disengage(): void {
    this.engaged = false
  }

  windowSnapshot(): readonly number[] {
    return [...this.recentCrashes]
  }
}

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
