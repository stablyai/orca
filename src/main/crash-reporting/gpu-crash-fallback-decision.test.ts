import { describe, expect, it } from 'vitest'
import { GpuCrashFallbackTracker } from './gpu-crash-fallback-decision'

describe('GpuCrashFallbackTracker', () => {
  it('engages at most once so the relaunch cannot loop', () => {
    const tracker = new GpuCrashFallbackTracker({ windowMs: 30_000, threshold: 2 })
    tracker.recordGpuCrash(100)
    expect(tracker.recordGpuCrash(200).shouldEngageFallback).toBe(true)
    expect(tracker.hasEngaged()).toBe(true)
    expect(tracker.recordGpuCrash(300)).toEqual({
      shouldEngageFallback: false,
      crashesInWindow: 2
    })
  })

  it('treats a span of exactly windowMs as inside the window', () => {
    const tracker = new GpuCrashFallbackTracker({ windowMs: 30_000, threshold: 3 })
    tracker.recordGpuCrash(0)
    tracker.recordGpuCrash(15_000)
    expect(tracker.recordGpuCrash(30_000)).toEqual({
      shouldEngageFallback: true,
      crashesInWindow: 3
    })
  })

  it('leaves the closest real-world non-burst alone', () => {
    const tracker = new GpuCrashFallbackTracker({ windowMs: 30_000, threshold: 3 })
    // Field timings have short adjacent gaps without three crashes in one window.
    for (const at of [0, 29_531, 55_136, 74_178]) {
      expect(tracker.recordGpuCrash(at).shouldEngageFallback).toBe(false)
    }
    expect(tracker.hasEngaged()).toBe(false)
  })
})
