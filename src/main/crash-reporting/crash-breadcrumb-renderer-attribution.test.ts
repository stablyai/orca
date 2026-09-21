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

  it('filters a renderer report to its own breadcrumbs while retaining global evidence', () => {
    recordCrashBreadcrumb('app_started', { packaged: true })
    recordCrashBreadcrumb('renderer_a_event', undefined, 'renderer:11')
    recordCrashBreadcrumb('renderer_b_event', undefined, 'renderer:22')

    expect(getCrashBreadcrumbSnapshot('renderer:11').map((entry) => entry.name)).toEqual([
      'app_started',
      'renderer_a_event'
    ])
    expect(getCrashBreadcrumbSnapshot('renderer:22').map((entry) => entry.name)).toEqual([
      'app_started',
      'renderer_b_event'
    ])
    expect(getCrashBreadcrumbSnapshot().map((entry) => entry.name)).toEqual([
      'app_started',
      'renderer_a_event',
      'renderer_b_event'
    ])
  })

  it('does not merge identical coalesced storms from sibling renderers', () => {
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

    expect(getCrashBreadcrumbSnapshot('renderer:11')).toHaveLength(1)
    expect(getCrashBreadcrumbSnapshot('renderer:22')).toHaveLength(1)
    expect(getCrashBreadcrumbSnapshot('renderer:11')[0]?.origin).toBe('renderer:11')
    expect(getCrashBreadcrumbSnapshot('renderer:22')[0]?.origin).toBe('renderer:22')
  })

  it('retains identical high-water profiles independently per renderer', () => {
    const profile = { rendererSurface: 'main', thresholdPct: 80, usedHeapMB: 512 }
    recordCrashBreadcrumb('renderer_memory_highwater', profile, 'renderer:11')
    recordCrashBreadcrumb('renderer_memory_highwater', profile, 'renderer:22')

    expect(getCrashBreadcrumbSnapshot('renderer:11')[0]?.origin).toBe('renderer:11')
    expect(getCrashBreadcrumbSnapshot('renderer:22')[0]?.origin).toBe('renderer:22')
  })

  it('preserves the reporter trail when sibling renderer traffic fills the ring', () => {
    for (let index = 0; index < 4; index += 1) {
      recordCrashBreadcrumb('renderer_memory_highwater', {
        rendererSurface: `surface-${index}`,
        thresholdPct: 80
      })
    }
    recordCrashBreadcrumb('renderer_a_event', undefined, 'renderer:11')
    for (let index = 0; index < 26; index += 1) {
      recordCrashBreadcrumb(`renderer_b_event_${index}`, undefined, 'renderer:22')
    }

    expect(getCrashBreadcrumbSnapshot('renderer:11').map((entry) => entry.name)).toContain(
      'renderer_a_event'
    )
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
