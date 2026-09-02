import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD,
  DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
  GpuCrashFallbackTracker,
  isGpuFallbackCrashCandidate
} from './gpu-crash-fallback-decision'
import { shouldRecordProcessGoneCrash } from './process-gone-classification'

/**
 * Replays the win32 GPU-child deaths from the 1.4.190 'crashed' renderer cluster
 * through the production decision path, so the reason no host was ever offered
 * Safe Graphics Mode is pinned rather than argued about.
 *
 * Each session below is one crash report's `Recent activity`; a breadcrumb's
 * `suppressedSinceLast=N` means N further identical GPU deaths were coalesced
 * into it, so the session saw N+1 GPU crashes.
 */

type FieldSession = {
  /** Crash-report id from the field bundle. */
  report: string
  /** GPU child crash times, ms since main-process start. */
  gpuCrashesMsSinceLaunch: number[]
}

// crashed.txt: every win32 report in the cluster. Times are (breadcrumb ts -
// mainProcessStartedAt); coalesced repeats are placed inside the same second,
// which is the only interval the emitted breadcrumb pins them to.
const CRASHED_CLUSTER_SESSIONS: FieldSession[] = [
  // 23:36:54.200 - 23:36:49.931, suppressedSinceLast=1 -> 2 crashes
  { report: 'db1f1ee2', gpuCrashesMsSinceLaunch: [4_269, 4_800] },
  // 02:58:25.287 - 02:58:20.749, no suppression -> 1 crash
  { report: '66cc54d8', gpuCrashesMsSinceLaunch: [4_538] },
  // 21:47:05.776 - 21:46:59.584, suppressedSinceLast=1 -> 2 crashes
  { report: '1f5564de', gpuCrashesMsSinceLaunch: [6_192, 6_240] },
  // 00:17:17.840 - 00:17:15.732, no suppression -> 1 crash
  { report: '96d8c63b', gpuCrashesMsSinceLaunch: [2_108] }
]

/** Ready-phase `child-process-gone` listener body — the wiring these claims rest on. */
function readChildProcessGoneListener(): string {
  const source = readFileSync(
    join(__dirname, '..', 'startup', 'main-process-ready-runtime.ts'),
    'utf8'
  )
  const start = source.indexOf("  app.on('child-process-gone'")
  expect(start).toBeGreaterThan(0)
  return source.slice(start, source.indexOf('\n  })', start))
}

function newTracker(): GpuCrashFallbackTracker {
  return new GpuCrashFallbackTracker({
    windowMs: DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
    threshold: DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD
  })
}

const FIELD_GPU_EVENT = {
  source: 'child',
  processType: 'GPU',
  serviceName: 'GPU',
  reason: 'crashed',
  expectedTeardown: 'none'
} as const

describe('1.4.190 win32 GPU-child crash cluster', () => {
  it('does not let process_gone_suppressed gate the fallback candidate check', () => {
    // The GPU death is suppressed as recoverable churn (no user-facing report)...
    expect(
      shouldRecordProcessGoneCrash({
        ...FIELD_GPU_EVENT,
        platform: 'win32',
        exitCode: -2147483645
      })
    ).toBe(false)
    // ...but the fallback path reads the raw child-process-gone event, so the
    // suppression cannot hide a broken driver from recovery.
    expect(
      isGpuFallbackCrashCandidate({
        platform: 'win32',
        processType: 'GPU',
        reason: 'crashed'
      })
    ).toBe(true)
    // Both assertions above still pass if the candidate check is moved behind the
    // suppressed-report path, so pin that nothing branches ahead of it in index.ts.
    const listener = readChildProcessGoneListener()
    const guardStart = listener.indexOf('isGpuFallbackCrashCandidate(')
    expect(guardStart).toBeGreaterThan(0)
    expect(listener.slice(0, guardStart).match(/\bif\s*\(/g) ?? []).toHaveLength(1)
    expect(listener).toMatch(
      /isGpuFallbackCrashCandidate\([\s\S]*?state\.gpuCrashDiagnostics\?\.record\(\)[\s\S]*?handleGpuChildCrash\(/
    )
    // The `if (` count alone still allows `recorded && isGpuFallbackCrashCandidate(...)`, which
    // re-couples recovery to the suppression decision, so pin the guard to that check alone.
    const recoveryGuard = listener.slice(
      listener.lastIndexOf('if (', guardStart),
      listener.indexOf('handleGpuChildCrash(')
    )
    expect(recoveryGuard).not.toMatch(/&&|\|\|/)
  })

  it('never reaches the burst threshold in any observed cluster session', () => {
    const outcomes = CRASHED_CLUSTER_SESSIONS.map((session) => {
      // Each launch constructs a fresh tracker (src/main/index.ts), so evidence
      // does not survive the relaunch these users performed after every crash.
      const tracker = newTracker()
      const engaged = session.gpuCrashesMsSinceLaunch.some(
        (at) => tracker.recordGpuCrash(at).shouldEngageFallback
      )
      return {
        report: session.report,
        gpuCrashes: session.gpuCrashesMsSinceLaunch.length,
        engagedSafeGraphicsPrompt: engaged
      }
    })
    expect(outcomes).toEqual([
      { report: 'db1f1ee2', gpuCrashes: 2, engagedSafeGraphicsPrompt: false },
      { report: '66cc54d8', gpuCrashes: 1, engagedSafeGraphicsPrompt: false },
      { report: '1f5564de', gpuCrashes: 2, engagedSafeGraphicsPrompt: false },
      { report: '96d8c63b', gpuCrashes: 1, engagedSafeGraphicsPrompt: false }
    ])
  })

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
