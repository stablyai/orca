import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  shouldRecordProcessGoneCrash,
  shouldRecoverRendererAfterProcessGone
} from './process-gone-classification'
import {
  markSystemSessionEnding,
  resetExpectedTeardownStateForTest,
  resolveExpectedTeardownScope,
  WINDOWS_SESSION_END_CRASH_SUPPRESSION_WINDOW_MS
} from './expected-teardown-state'

function shouldRecordKilledRenderer(expectedTeardown: 'none' | 'renderer-reload' | 'app-shutdown') {
  return shouldRecordProcessGoneCrash({
    platform: 'win32',
    source: 'renderer',
    processType: 'renderer',
    reason: 'killed',
    exitCode: 1,
    expectedTeardown
  })
}

let now: number

beforeEach(() => {
  now = 1_000
  resetExpectedTeardownStateForTest(() => now)
})

afterEach(() => {
  vi.restoreAllMocks()
  resetExpectedTeardownStateForTest()
})

describe('expected teardown state', () => {
  it('uses a product-chosen five-second harm bound, not a Windows lifetime guarantee', () => {
    // Restart Manager may wait 30s; tree-kills after this bound remain reportable by design.
    expect(WINDOWS_SESSION_END_CRASH_SUPPRESSION_WINDOW_MS).toBe(5_000)
  })

  it('uses the production monotonic clock by default', () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(1_000).mockReturnValue(1_001)
    vi.spyOn(Date, 'now').mockReturnValueOnce(10_000).mockReturnValue(15_000)
    resetExpectedTeardownStateForTest()

    markSystemSessionEnding()

    expect(
      resolveExpectedTeardownScope({
        isQuitting: false,
        isQuittingForUpdate: false,
        isExpectedRendererReload: false
      })
    ).toBe('app-shutdown')
  })

  it('does not resurrect session-end after an injected clock rollback and catch-up', () => {
    now = 3_600_000
    markSystemSessionEnding()
    now = 0
    const rollbackScope = resolveExpectedTeardownScope({
      isQuitting: false,
      isQuittingForUpdate: false,
      isExpectedRendererReload: false
    })
    now = 3_600_001
    const catchUpScope = resolveExpectedTeardownScope({
      isQuitting: false,
      isQuittingForUpdate: false,
      isExpectedRendererReload: false
    })

    expect(rollbackScope).toBe('none')
    expect(catchUpScope).toBe('none')
  })

  it('does not resurrect session-end after expiry and an injected backtrack', () => {
    markSystemSessionEnding()
    now += WINDOWS_SESSION_END_CRASH_SUPPRESSION_WINDOW_MS
    const expiredScope = resolveExpectedTeardownScope({
      isQuitting: false,
      isQuittingForUpdate: false,
      isExpectedRendererReload: false
    })
    now -= 1
    const backtrackScope = resolveExpectedTeardownScope({
      isQuitting: false,
      isQuittingForUpdate: false,
      isExpectedRendererReload: false
    })

    expect(expiredScope).toBe('none')
    expect(backtrackScope).toBe('none')
  })

  it('re-arms the suppression window on repeated session-end events', () => {
    markSystemSessionEnding()
    now += WINDOWS_SESSION_END_CRASH_SUPPRESSION_WINDOW_MS - 1
    markSystemSessionEnding()
    now += WINDOWS_SESSION_END_CRASH_SUPPRESSION_WINDOW_MS - 1

    expect(
      resolveExpectedTeardownScope({
        isQuitting: false,
        isQuittingForUpdate: false,
        isExpectedRendererReload: false
      })
    ).toBe('app-shutdown')
  })

  it('classifies killed/1 just inside the session-end window as app shutdown', () => {
    markSystemSessionEnding()
    now += WINDOWS_SESSION_END_CRASH_SUPPRESSION_WINDOW_MS - 1
    const scope = resolveExpectedTeardownScope({
      isQuitting: false,
      isQuittingForUpdate: false,
      isExpectedRendererReload: false
    })

    expect(scope).toBe('app-shutdown')
    expect(shouldRecordKilledRenderer(scope)).toBe(false)
  })

  it('keeps killed/1 reportable at and just outside the session-end boundary', () => {
    markSystemSessionEnding()
    now += WINDOWS_SESSION_END_CRASH_SUPPRESSION_WINDOW_MS
    const boundaryScope = resolveExpectedTeardownScope({
      isQuitting: false,
      isQuittingForUpdate: false,
      isExpectedRendererReload: false
    })
    now += 1
    const outsideScope = resolveExpectedTeardownScope({
      isQuitting: false,
      isQuittingForUpdate: false,
      isExpectedRendererReload: false
    })

    expect(boundaryScope).toBe('none')
    expect(outsideScope).toBe('none')
    expect(shouldRecordKilledRenderer(outsideScope)).toBe(true)
  })

  it('excludes session-end from recovery while preserving in-app quit suppression', () => {
    markSystemSessionEnding()
    const sessionEndScope = resolveExpectedTeardownScope({
      isQuitting: false,
      isQuittingForUpdate: false,
      isExpectedRendererReload: false,
      includeSystemSessionEnd: false
    })
    const inAppQuitScope = resolveExpectedTeardownScope({
      isQuitting: true,
      isQuittingForUpdate: false,
      isExpectedRendererReload: false,
      includeSystemSessionEnd: false
    })

    expect(sessionEndScope).toBe('none')
    expect(
      shouldRecoverRendererAfterProcessGone({
        reason: 'killed',
        expectedTeardown: sessionEndScope
      })
    ).toBe(true)
    expect(inAppQuitScope).toBe('app-shutdown')
    expect(
      shouldRecoverRendererAfterProcessGone({
        reason: 'killed',
        expectedTeardown: inAppQuitScope
      })
    ).toBe(false)
  })

  it('preserves existing update and renderer-reload scopes', () => {
    expect(
      resolveExpectedTeardownScope({
        isQuitting: false,
        isQuittingForUpdate: true,
        isExpectedRendererReload: false
      })
    ).toBe('app-shutdown')
    expect(
      resolveExpectedTeardownScope({
        isQuitting: false,
        isQuittingForUpdate: false,
        isExpectedRendererReload: true,
        includeSystemSessionEnd: false
      })
    ).toBe('renderer-reload')
  })
})
