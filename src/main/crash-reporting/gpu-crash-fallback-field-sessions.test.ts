import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD,
  DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
  GpuCrashFallbackTracker
} from './gpu-crash-fallback-decision'

function newTracker(): GpuCrashFallbackTracker {
  return new GpuCrashFallbackTracker({
    windowMs: DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
    threshold: DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD
  })
}

describe('1.4.190 win32 GPU-child crash cluster', () => {
  it('engages on the session that did reach three crashes (field launch 51b9e93c)', () => {
    // oom.txt, win32: GPU crashed/exitCode=34 with suppressedSinceLast=2, then
    // `gpu_fallback_engaged (crashesInWindow=3)` and `gpu_fallback_restart_deferred`.
    const tracker = newTracker()
    expect(tracker.recordGpuCrash(3_600_000).shouldEngageFallback).toBe(false)
    expect(tracker.recordGpuCrash(3_601_000).shouldEngageFallback).toBe(false)
    expect(tracker.recordGpuCrash(3_601_890)).toEqual({
      shouldEngageFallback: true,
      crashesInWindow: 3
    })
  })
})
