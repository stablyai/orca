import { describe, expect, it } from 'vitest'
import { GpuCrashFallbackCoordinator } from './gpu-crash-fallback-coordinator'
import { GpuCrashFallbackTracker } from './gpu-crash-fallback-decision'

const startedAt = Date.UTC(2026, 7, 3, 22, 40, 14)

/** One physical GPU fault as the app sees it: child death, then the renderer. */
function feedGpuFault(
  coordinator: GpuCrashFallbackCoordinator,
  msSinceLaunch: number,
  options: { rendererDelayMs?: number; exitCode?: number | null } = {}
): { engaged: boolean; crashesInWindow: number; cascade: boolean } {
  const exitCode = options.exitCode ?? 34
  const at = startedAt + msSinceLaunch
  const verdict = coordinator.recordGpuChildCrash({ msSinceLaunch, at, exitCode })
  const cascade = coordinator.claimRendererCascade({
    reason: 'crashed',
    exitCode,
    at: at + (options.rendererDelayMs ?? 83)
  })
  return {
    engaged: verdict.shouldEngageFallback,
    crashesInWindow: verdict.crashesInWindow,
    cascade
  }
}

function createCoordinator(): GpuCrashFallbackCoordinator {
  return new GpuCrashFallbackCoordinator({
    tracker: new GpuCrashFallbackTracker({ windowMs: 30_000, threshold: 3 })
  })
}

describe('GpuCrashFallbackCoordinator', () => {
  it('counts one GPU fault once even when the renderer dies behind it', () => {
    // F0BNM0R87SL shape: the renderer goes down ~83ms after the GPU child with
    // the same exit code. Counting that tail too would halve the tuned threshold.
    const coordinator = createCoordinator()
    expect(feedGpuFault(coordinator, 1_000)).toEqual({
      engaged: false,
      crashesInWindow: 1,
      cascade: true
    })
    expect(feedGpuFault(coordinator, 21_000)).toEqual({
      engaged: false,
      crashesInWindow: 2,
      cascade: true
    })
  })

  it('still engages on the third real fault inside the window', () => {
    const coordinator = createCoordinator()
    feedGpuFault(coordinator, 0)
    feedGpuFault(coordinator, 10_000)
    expect(feedGpuFault(coordinator, 20_000)).toEqual({
      engaged: true,
      crashesInWindow: 3,
      cascade: false
    })
  })

  it('does not arm attribution for the crash that engaged fallback', () => {
    const coordinator = createCoordinator()
    feedGpuFault(coordinator, 0)
    feedGpuFault(coordinator, 10_000)
    // The engaging crash relaunches the app; its renderer tail is teardown noise.
    expect(feedGpuFault(coordinator, 20_000).cascade).toBe(false)
  })

  it('leaves unrelated renderer deaths unclaimed', () => {
    const coordinator = createCoordinator()
    coordinator.recordGpuChildCrash({ msSinceLaunch: 1_000, at: startedAt, exitCode: 34 })
    expect(
      coordinator.claimRendererCascade({ reason: 'oom', exitCode: 34, at: startedAt + 100 })
    ).toBe(false)
  })
})
