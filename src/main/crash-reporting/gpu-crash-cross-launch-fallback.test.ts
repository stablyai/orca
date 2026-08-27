import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openGpuCrashHistoryLaunch } from '../startup/gpu-crash-history-store'
import { GpuCrashFallbackTracker } from './gpu-crash-fallback-decision'
import type { GpuCrashHistoryEntry, GpuCrashHistoryLaunch } from './gpu-crash-fallback-decision'

/** In-memory stand-in for the on-disk ring, shared across simulated relaunches. */
function createHistoryFake(): {
  openLaunch: () => GpuCrashHistoryLaunch
  entries: GpuCrashHistoryEntry[]
} {
  const entries: GpuCrashHistoryEntry[] = []
  let launchSeq = 0
  let declinedAt: number | null = null
  return {
    entries,
    openLaunch: () => {
      launchSeq += 1
      const currentLaunchSeq = launchSeq
      return {
        launchSeq: currentLaunchSeq,
        get declinedAt() {
          return declinedAt
        },
        append: (crash) => {
          entries.push({ ...crash, launchSeq: currentLaunchSeq })
          return entries
        },
        noteRestartDeclined: (at) => {
          declinedAt = at
        }
      }
    }
  }
}

describe('GPU fallback across relaunches', () => {
  it('engages after repeated launches that each die on the first GPU crash', () => {
    // F0BNM0R87SL: the GPU crash takes the app down, so every launch starts with
    // an empty tracker and the in-launch burst rule can never reach 3.
    const history = createHistoryFake()
    const startedAt = Date.UTC(2026, 7, 3, 22, 40, 0)
    const results: boolean[] = []
    for (let launch = 0; launch < 5; launch += 1) {
      const tracker = new GpuCrashFallbackTracker({
        windowMs: 30_000,
        threshold: 3,
        history: history.openLaunch()
      })
      const engaged = tracker.recordGpuCrash(3_000, {
        at: startedAt + launch * 90_000,
        exitCode: 3_000
      }).shouldEngageFallback
      results.push(engaged)
      if (engaged) {
        // The app relaunches into software rendering; later launches never happen.
        break
      }
    }
    expect(results).toEqual([false, false, true])
    expect(history.entries.map((entry) => entry.launchSeq)).toEqual([1, 2, 3])
    expect(history.entries.every((entry) => entry.ts >= startedAt)).toBe(true)
  })

  it('engages on crashes clustered in wall-clock time even when launches are not consecutive', () => {
    const history = createHistoryFake()
    const startedAt = Date.UTC(2026, 7, 3, 22, 40, 0)
    // Launches 1 and 3 crash, 2 does not: no streak, but three crashes in 6 min.
    const crashingLaunch = (at: number): boolean => {
      const tracker = new GpuCrashFallbackTracker({
        windowMs: 30_000,
        threshold: 3,
        history: history.openLaunch()
      })
      return tracker.recordGpuCrash(1_000, { at, exitCode: null }).shouldEngageFallback
    }
    expect(crashingLaunch(startedAt)).toBe(false)
    history.openLaunch()
    expect(crashingLaunch(startedAt + 120_000)).toBe(false)
    history.openLaunch()
    expect(crashingLaunch(startedAt + 360_000)).toBe(true)
  })

  it('ignores crashes that aged out of the cross-launch window', () => {
    const history = createHistoryFake()
    const startedAt = Date.UTC(2026, 7, 3, 10, 0, 0)
    const crashingLaunch = (at: number): boolean => {
      const tracker = new GpuCrashFallbackTracker({
        windowMs: 30_000,
        threshold: 3,
        crossLaunchWindowMs: 30 * 60_000,
        history: history.openLaunch()
      })
      return tracker.recordGpuCrash(1_000, { at, exitCode: null }).shouldEngageFallback
    }
    // One crash a day apart is a flaky app-start race, not a broken driver — and
    // the crash-free launches in between keep the streak from ever forming.
    expect(crashingLaunch(startedAt)).toBe(false)
    history.openLaunch()
    expect(crashingLaunch(startedAt + 86_400_000)).toBe(false)
    history.openLaunch()
    expect(crashingLaunch(startedAt + 2 * 86_400_000)).toBe(false)
  })

  it('leaves the closest real-world non-burst alone once crashes are persisted', () => {
    const history = createHistoryFake()
    const tracker = new GpuCrashFallbackTracker({
      windowMs: 30_000,
      threshold: 3,
      history: history.openLaunch()
    })
    const startedAt = Date.UTC(2026, 7, 3, 22, 40, 0)
    // Field telemetry's tightest 4-crash launch that is *not* a broken driver.
    // The in-launch rule already ruled it out; the persisted rules must not
    // re-litigate a single launch behind its back.
    for (const at of [0, 29_531, 55_136, 74_178]) {
      expect(
        tracker.recordGpuCrash(at, { at: startedAt + at, exitCode: 3_000 }).shouldEngageFallback
      ).toBe(false)
    }
  })

  it('does not let one recovered launch bankroll a later benign crash', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'gpu-cross-launch-churn-'))
    const environment = {
      appVersion: '1.4.167',
      electronVersion: '38.2.0',
      platform: 'win32' as const
    }
    const startedAt = Date.UTC(2026, 7, 3, 22, 40, 0)
    try {
      // F0BGRN5912M through the real ring: 4 recovered crashes in one launch that
      // the burst rule spares. Counting raw crashes would let a single ordinary
      // crash in the next launch cash them in.
      const first = new GpuCrashFallbackTracker({
        windowMs: 30_000,
        threshold: 3,
        history: openGpuCrashHistoryLaunch(userDataPath, environment)
      })
      for (const at of [0, 29_531, 55_136, 74_178]) {
        expect(
          first.recordGpuCrash(at, { at: startedAt + at, exitCode: 34 }).shouldEngageFallback
        ).toBe(false)
      }
      const second = new GpuCrashFallbackTracker({
        windowMs: 30_000,
        threshold: 3,
        history: openGpuCrashHistoryLaunch(userDataPath, environment)
      })
      expect(
        second.recordGpuCrash(1_000, { at: startedAt + 374_178, exitCode: 34 }).shouldEngageFallback
      ).toBe(false)
    } finally {
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('ignores a crashing-launch streak spread over weeks', () => {
    const history = createHistoryFake()
    const day = 86_400_000
    const startedAt = Date.UTC(2026, 7, 3, 10, 0, 0)
    const crashingLaunch = (at: number): boolean =>
      new GpuCrashFallbackTracker({
        windowMs: 30_000,
        threshold: 3,
        history: history.openLaunch()
      }).recordGpuCrash(1_000, { at, exitCode: 34 }).shouldEngageFallback
    // One lone GPU crash per session is ordinary Chromium churn (13 of the 14
    // GPU-crash reports in the corpus). Only a *recent* run of them is a driver.
    expect(crashingLaunch(startedAt)).toBe(false)
    expect(crashingLaunch(startedAt + 7 * day)).toBe(false)
    expect(crashingLaunch(startedAt + 14 * day)).toBe(false)
  })

  it('still engages for a once-a-day user whose every launch dies on the GPU', () => {
    const history = createHistoryFake()
    const day = 86_400_000
    const startedAt = Date.UTC(2026, 7, 3, 10, 0, 0)
    const crashingLaunch = (at: number): boolean =>
      new GpuCrashFallbackTracker({
        windowMs: 30_000,
        threshold: 3,
        history: history.openLaunch()
      }).recordGpuCrash(1_000, { at, exitCode: 34 }).shouldEngageFallback
    expect(crashingLaunch(startedAt)).toBe(false)
    expect(crashingLaunch(startedAt + day)).toBe(false)
    expect(crashingLaunch(startedAt + 2 * day)).toBe(true)
  })

  it('stops re-prompting after the user keeps running, then asks again a day later', () => {
    const history = createHistoryFake()
    const startedAt = Date.UTC(2026, 7, 3, 10, 0, 0)
    const crashingLaunch = (at: number): boolean => {
      const launch = history.openLaunch()
      const engaged = new GpuCrashFallbackTracker({
        windowMs: 30_000,
        threshold: 3,
        history: launch
      }).recordGpuCrash(1_000, { at, exitCode: 34 }).shouldEngageFallback
      if (engaged) {
        // The user picks "Keep Running" every time.
        launch.noteRestartDeclined(at)
      }
      return engaged
    }
    expect(crashingLaunch(startedAt)).toBe(false)
    expect(crashingLaunch(startedAt + 600_000)).toBe(false)
    expect(crashingLaunch(startedAt + 1_200_000)).toBe(true)
    const declinedAt = startedAt + 1_200_000
    expect(crashingLaunch(declinedAt + 600_000)).toBe(false)
    expect(crashingLaunch(declinedAt + 12 * 3_600_000)).toBe(false)
    // A day on, the driver is still broken: it is fair to ask once more.
    expect(crashingLaunch(declinedAt + 25 * 3_600_000)).toBe(true)
  })

  it('survives real relaunches through the on-disk ring', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'gpu-cross-launch-'))
    const environment = {
      appVersion: '1.4.167',
      electronVersion: '38.2.0',
      platform: 'win32' as const
    }
    const startedAt = Date.UTC(2026, 7, 3, 22, 40, 14)
    try {
      const relaunch = (at: number): boolean =>
        new GpuCrashFallbackTracker({
          windowMs: 30_000,
          threshold: 3,
          history: openGpuCrashHistoryLaunch(userDataPath, environment)
        }).recordGpuCrash(2_000, { at, exitCode: 3_000 }).shouldEngageFallback
      expect(relaunch(startedAt)).toBe(false)
      expect(relaunch(startedAt + 88_000)).toBe(false)
      expect(relaunch(startedAt + 190_000)).toBe(true)
    } finally {
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('keeps the in-launch burst rule intact when nothing is persisted', () => {
    const tracker = new GpuCrashFallbackTracker({ windowMs: 30_000, threshold: 3 })
    expect(tracker.recordGpuCrash(500).shouldEngageFallback).toBe(false)
    expect(tracker.recordGpuCrash(8_000).shouldEngageFallback).toBe(false)
    expect(tracker.recordGpuCrash(16_000)).toEqual({
      shouldEngageFallback: true,
      crashesInWindow: 3
    })
  })
})
