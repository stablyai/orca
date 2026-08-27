import { GpuCrashCascadeAttributor } from './gpu-crash-cascade-attribution'
import type { GpuCrashFallbackTracker } from './gpu-crash-fallback-decision'

export type GpuCrashFallbackVerdict = {
  shouldEngageFallback: boolean
  crashesInWindow: number
}

/**
 * Routes GPU faults into the fallback tracker exactly once each.
 *
 * Why: one physical GPU fault surfaces twice — the suppressed GPU child death
 * and, ~100ms later, the renderer going down with the same exit code. The tail
 * names the cause in the crash trail, but recording it as a second crash would
 * halve the tuned burst threshold (3 in 30s would fire after 2 real faults), so
 * it is attribution only.
 */
export class GpuCrashFallbackCoordinator {
  private readonly tracker: GpuCrashFallbackTracker
  private readonly attributor: GpuCrashCascadeAttributor

  constructor(options: {
    tracker: GpuCrashFallbackTracker
    attributor?: GpuCrashCascadeAttributor
  }) {
    this.tracker = options.tracker
    this.attributor = options.attributor ?? new GpuCrashCascadeAttributor()
  }

  /** Counts a GPU child crash and arms cascade attribution for its renderer tail. */
  recordGpuChildCrash(crash: {
    msSinceLaunch: number
    at: number
    exitCode: number | null
  }): GpuCrashFallbackVerdict {
    const verdict = this.tracker.recordGpuCrash(crash.msSinceLaunch, {
      at: crash.at,
      exitCode: crash.exitCode
    })
    if (!verdict.shouldEngageFallback) {
      this.attributor.noteSuppressedGpuCrash({ at: crash.at, exitCode: crash.exitCode })
    }
    return verdict
  }

  /**
   * True when this renderer death is the tail of a GPU fault already counted by
   * `recordGpuChildCrash` — for the crash trail, never for the fallback rules.
   */
  claimRendererCascade(crash: { reason: string; exitCode: number | null; at: number }): boolean {
    return this.attributor.claimRendererCascade(crash)
  }
}
