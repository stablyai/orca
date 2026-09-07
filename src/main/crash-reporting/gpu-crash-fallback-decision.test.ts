import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD,
  DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
  GpuCrashFallbackTracker,
  isGpuChildProcessType,
  isGpuFallbackCrashCandidate
} from './gpu-crash-fallback-decision'

describe('GpuCrashFallbackTracker', () => {
  it('engages fallback once GPU crashes hit the threshold inside the window', () => {
    const tracker = new GpuCrashFallbackTracker({ windowMs: 30_000, threshold: 3 })
    // F0BDNADU79Q / F0BDNRZ5MDG: GPU child dies within seconds of launch.
    expect(tracker.recordGpuCrash(500)).toEqual({
      shouldEngageFallback: false,
      crashesInWindow: 1
    })
    expect(tracker.recordGpuCrash(8_000)).toEqual({
      shouldEngageFallback: false,
      crashesInWindow: 2
    })
    expect(tracker.recordGpuCrash(16_000)).toEqual({
      shouldEngageFallback: true,
      crashesInWindow: 3
    })
  })

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
    // Isolated hiccups spread over 45s are normal Chromium churn, not a burst:
    // the first two have aged out by the time the third arrives.
    expect(tracker.recordGpuCrash(45_000)).toEqual({
      shouldEngageFallback: false,
      crashesInWindow: 1
    })
    expect(tracker.hasEngaged()).toBe(false)
  })

  it('engages on a burst that starts long after launch (session 12e6ee64)', () => {
    const tracker = new GpuCrashFallbackTracker({ windowMs: 30_000, threshold: 3 })
    // Real crash times, ms since launch. The burst is 3 crashes in 26.0s —
    // inside the window — but begins 920s in, so the old launch-anchored
    // check rejected every one and the renderer died 39s later.
    expect(tracker.recordGpuCrash(242_137).shouldEngageFallback).toBe(false)
    expect(tracker.recordGpuCrash(920_110).shouldEngageFallback).toBe(false)
    expect(tracker.recordGpuCrash(926_462).shouldEngageFallback).toBe(false)
    expect(tracker.recordGpuCrash(946_115)).toEqual({
      shouldEngageFallback: true,
      crashesInWindow: 3
    })
  })

  it('treats a span of exactly windowMs as inside the window', () => {
    const tracker = new GpuCrashFallbackTracker({ windowMs: 30_000, threshold: 3 })
    tracker.recordGpuCrash(0)
    tracker.recordGpuCrash(15_000)
    // Why pinned: "3 crashes within 30s" includes a 30.000s span. An exclusive
    // cutoff here would silently need a 4th crash to ever engage on the boundary.
    expect(tracker.recordGpuCrash(30_000)).toEqual({
      shouldEngageFallback: true,
      crashesInWindow: 3
    })
  })

  it('leaves the closest real-world non-burst alone', () => {
    const tracker = new GpuCrashFallbackTracker({ windowMs: 30_000, threshold: 3 })
    // Field telemetry's tightest 4-crash launch that is *not* a broken driver.
    // Consecutive gaps (29.5s, 25.6s) each fit the window, so pruning has to
    // retire the old entry every time or this session gets relaunched for free.
    for (const at of [0, 29_531, 55_136, 74_178]) {
      expect(tracker.recordGpuCrash(at).shouldEngageFallback).toBe(false)
    }
    expect(tracker.hasEngaged()).toBe(false)
  })

  it('ignores a slow drip that never fills the window', () => {
    const tracker = new GpuCrashFallbackTracker({ windowMs: 30_000, threshold: 3 })
    // One crash every 20s forever: always 2 in the window, never a burst.
    for (const at of [0, 20_000, 40_000, 60_000, 80_000, 100_000]) {
      expect(tracker.recordGpuCrash(at).shouldEngageFallback).toBe(false)
    }
    expect(tracker.hasEngaged()).toBe(false)
  })

  it('never retains a crash older than the window, even on a backwards clock jump', () => {
    const tracker = new GpuCrashFallbackTracker({ windowMs: 30_000, threshold: 3 })
    tracker.recordGpuCrash(100_000)
    tracker.recordGpuCrash(1_000)
    // Why: pruning scans the sorted prefix and stops at the first live entry, so
    // an out-of-order value parked at the tail would be counted forever. Assert
    // the invariant directly — the crash count alone cannot distinguish this.
    const window = tracker.windowSnapshot()
    const newest = window.at(-1) ?? 0
    expect(window.every((at) => newest - at <= 30_000)).toBe(true)
    expect([...window]).toEqual([...window].sort((left, right) => left - right))
  })

  it('ignores impossible timestamps', () => {
    const tracker = new GpuCrashFallbackTracker({ windowMs: 30_000, threshold: 1 })
    expect(tracker.recordGpuCrash(-1).shouldEngageFallback).toBe(false)
    expect(tracker.recordGpuCrash(Number.NaN).shouldEngageFallback).toBe(false)
    expect(tracker.hasEngaged()).toBe(false)
  })

  it('classifies GPU child process types case-insensitively', () => {
    expect(isGpuChildProcessType('GPU')).toBe(true)
    expect(isGpuChildProcessType('gpu')).toBe(true)
    expect(isGpuChildProcessType('Utility')).toBe(false)
    expect(isGpuChildProcessType(undefined)).toBe(false)
  })

  it('ships conservative defaults', () => {
    expect(DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS).toBe(30_000)
    expect(DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD).toBe(3)
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
