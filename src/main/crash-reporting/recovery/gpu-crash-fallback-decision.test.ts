import { describe, expect, it } from 'vitest'
import { GpuCrashFallbackTracker } from './gpu-crash-fallback-decision'

describe('GpuCrashFallbackTracker', () => {
  it('leaves the closest real-world non-burst alone', () => {
    const tracker = new GpuCrashFallbackTracker({ windowMs: 30_000, threshold: 3 })
    // Field timings have short adjacent gaps without three crashes in one window.
    for (const at of [0, 29_531, 55_136, 74_178]) {
      expect(tracker.recordGpuCrash(at).shouldEngageFallback).toBe(false)
    }
    expect(tracker.hasEngaged()).toBe(false)
  })
})
