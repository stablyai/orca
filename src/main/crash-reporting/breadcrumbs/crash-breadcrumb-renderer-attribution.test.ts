import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearCrashBreadcrumbsForTest,
  getCrashBreadcrumbSnapshot,
  recordCoalescedCrashBreadcrumb,
  recordCrashBreadcrumb
} from './crash-breadcrumb-store'

describe('renderer crash breadcrumb attribution', () => {
  beforeEach(() => {
    clearCrashBreadcrumbsForTest()
  })

  it('folds pending repeats using the reporter-specific evidence window', () => {
    recordCoalescedCrashBreadcrumb({
      name: 'renderer_error',
      data: { message: 'boom' },
      coalesceKey: 'renderer:11\u0000renderer_error:boom',
      minIntervalMs: 30_000,
      origin: 'renderer:11'
    })
    recordCoalescedCrashBreadcrumb({
      name: 'renderer_error',
      data: { message: 'boom' },
      coalesceKey: 'renderer:22\u0000renderer_error:boom',
      minIntervalMs: 30_000,
      origin: 'renderer:22'
    })
    recordCoalescedCrashBreadcrumb({
      name: 'renderer_error',
      data: { message: 'boom' },
      coalesceKey: 'renderer:22\u0000renderer_error:boom',
      minIntervalMs: 30_000,
      origin: 'renderer:22'
    })
    recordCoalescedCrashBreadcrumb({
      name: 'renderer_error',
      data: { message: 'boom' },
      coalesceKey: 'renderer:11\u0000renderer_error:boom',
      minIntervalMs: 30_000,
      origin: 'renderer:11'
    })
    for (let index = 0; index < 4; index += 1) {
      recordCrashBreadcrumb(
        'renderer_memory_highwater',
        { rendererSurface: `surface-${index}`, thresholdPct: 80 },
        'renderer:22'
      )
    }
    for (let index = 0; index < 25; index += 1) {
      recordCrashBreadcrumb(`renderer_b_event_${index}`, undefined, 'renderer:22')
    }

    const snapshot = getCrashBreadcrumbSnapshot('renderer:11')

    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]?.data).toEqual({ message: 'boom', suppressedSinceLast: 1 })

    const siblingSnapshot = getCrashBreadcrumbSnapshot('renderer:22')
    expect(siblingSnapshot.find((entry) => entry.name === 'renderer_error')?.data).toEqual({
      message: 'boom',
      suppressedSinceLast: 1
    })
  })
})
