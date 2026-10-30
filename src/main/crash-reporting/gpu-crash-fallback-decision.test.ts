import { describe, expect, it } from 'vitest'
import { GpuCrashFallbackTracker, isGpuFallbackCrashCandidate } from './gpu-crash-fallback-decision'

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

  it('drops crashes that age out of the rolling window', () => {
    const tracker = new GpuCrashFallbackTracker({ windowMs: 30_000, threshold: 3 })
    tracker.recordGpuCrash(1_000)
    tracker.recordGpuCrash(2_000)
    expect(tracker.recordGpuCrash(45_000)).toEqual({
      shouldEngageFallback: false,
      crashesInWindow: 1
    })
    expect(tracker.hasEngaged()).toBe(false)
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

  it('ignores impossible timestamps', () => {
    const tracker = new GpuCrashFallbackTracker({ windowMs: 30_000, threshold: 1 })
    expect(tracker.recordGpuCrash(-1).shouldEngageFallback).toBe(false)
    expect(tracker.recordGpuCrash(Number.NaN).shouldEngageFallback).toBe(false)
    expect(tracker.hasEngaged()).toBe(false)
  })
})

describe('isGpuFallbackCrashCandidate', () => {
  it('tracks only crash-shaped Windows GPU child failures', () => {
    for (const reason of ['abnormal-exit', 'crashed', 'launch-failed']) {
      expect(
        isGpuFallbackCrashCandidate({
          platform: 'win32',
          processType: 'GPU',
          reason
        })
      ).toBe(true)
    }
  })

  it('ignores normal GPU exits and non-Windows platforms', () => {
    expect(
      isGpuFallbackCrashCandidate({
        platform: 'win32',
        processType: 'GPU',
        reason: 'clean-exit'
      })
    ).toBe(false)
    expect(
      isGpuFallbackCrashCandidate({
        platform: 'win32',
        processType: 'GPU',
        reason: 'killed'
      })
    ).toBe(false)
    expect(
      isGpuFallbackCrashCandidate({
        platform: 'linux',
        processType: 'GPU',
        reason: 'crashed'
      })
    ).toBe(false)
    expect(
      isGpuFallbackCrashCandidate({
        platform: 'win32',
        processType: 'Utility',
        reason: 'crashed'
      })
    ).toBe(false)
  })
})
