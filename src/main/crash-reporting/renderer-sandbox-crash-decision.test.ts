import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RENDERER_SANDBOX_FALLBACK_THRESHOLD,
  DEFAULT_RENDERER_SANDBOX_FALLBACK_WINDOW_MS,
  RendererSandboxCrashFallbackTracker,
  STATUS_BREAKPOINT_EXIT_CODE,
  isRendererSandboxFallbackCrashCandidate
} from './renderer-sandbox-crash-decision'

function makeTracker(overrides: { windowMs?: number; threshold?: number } = {}) {
  return new RendererSandboxCrashFallbackTracker({
    windowMs: overrides.windowMs ?? DEFAULT_RENDERER_SANDBOX_FALLBACK_WINDOW_MS,
    threshold: overrides.threshold ?? DEFAULT_RENDERER_SANDBOX_FALLBACK_THRESHOLD
  })
}

describe('RendererSandboxCrashFallbackTracker', () => {
  it('engages once the threshold of in-window crashes is reached', () => {
    const tracker = makeTracker({ threshold: 3 })
    expect(tracker.recordRendererCrash(1_000)).toEqual({
      shouldEngageFallback: false,
      crashesInWindow: 1
    })
    expect(tracker.recordRendererCrash(3_000)).toEqual({
      shouldEngageFallback: false,
      crashesInWindow: 2
    })
    expect(tracker.recordRendererCrash(6_000)).toEqual({
      shouldEngageFallback: true,
      crashesInWindow: 3
    })
    expect(tracker.hasEngaged()).toBe(true)
  })

  it('ignores crashes outside the post-launch window', () => {
    const tracker = makeTracker({ windowMs: 30_000, threshold: 2 })
    expect(tracker.recordRendererCrash(30_001)).toEqual({
      shouldEngageFallback: false,
      crashesInWindow: 0
    })
    expect(tracker.recordRendererCrash(-1)).toEqual({
      shouldEngageFallback: false,
      crashesInWindow: 0
    })
    expect(tracker.recordRendererCrash(Number.NaN)).toEqual({
      shouldEngageFallback: false,
      crashesInWindow: 0
    })
    // A crash exactly on the window boundary still counts.
    expect(tracker.recordRendererCrash(30_000).crashesInWindow).toBe(1)
  })

  it('engages at most once and stops counting afterwards', () => {
    const tracker = makeTracker({ threshold: 2 })
    tracker.recordRendererCrash(500)
    expect(tracker.recordRendererCrash(1_000).shouldEngageFallback).toBe(true)
    // Further crashes never re-engage, so the caller relaunches only once.
    expect(tracker.recordRendererCrash(1_500)).toEqual({
      shouldEngageFallback: false,
      crashesInWindow: 2
    })
  })
})

describe('isRendererSandboxFallbackCrashCandidate', () => {
  it('matches only a win32 renderer STATUS_BREAKPOINT exit', () => {
    expect(
      isRendererSandboxFallbackCrashCandidate({
        platform: 'win32',
        source: 'renderer',
        exitCode: STATUS_BREAKPOINT_EXIT_CODE
      })
    ).toBe(true)
  })

  it('rejects renderer OOM (#9872) and other renderer exit codes', () => {
    expect(
      isRendererSandboxFallbackCrashCandidate({
        platform: 'win32',
        source: 'renderer',
        exitCode: -36861
      })
    ).toBe(false)
    expect(
      isRendererSandboxFallbackCrashCandidate({
        platform: 'win32',
        source: 'renderer',
        exitCode: 5
      })
    ).toBe(false)
    expect(
      isRendererSandboxFallbackCrashCandidate({
        platform: 'win32',
        source: 'renderer',
        exitCode: null
      })
    ).toBe(false)
  })

  it('rejects GPU/child STATUS_BREAKPOINT and non-win32 platforms', () => {
    expect(
      isRendererSandboxFallbackCrashCandidate({
        platform: 'win32',
        source: 'child',
        exitCode: STATUS_BREAKPOINT_EXIT_CODE
      })
    ).toBe(false)
    expect(
      isRendererSandboxFallbackCrashCandidate({
        platform: 'darwin',
        source: 'renderer',
        exitCode: STATUS_BREAKPOINT_EXIT_CODE
      })
    ).toBe(false)
    expect(
      isRendererSandboxFallbackCrashCandidate({
        platform: 'linux',
        source: 'renderer',
        exitCode: STATUS_BREAKPOINT_EXIT_CODE
      })
    ).toBe(false)
  })
})
