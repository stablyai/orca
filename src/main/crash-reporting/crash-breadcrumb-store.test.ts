import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearCrashBreadcrumbsForTest,
  getCrashBreadcrumbSnapshot,
  recordCoalescedCrashBreadcrumb,
  recordCrashBreadcrumb
} from './crash-breadcrumb-store'

afterEach(() => {
  vi.useRealTimers()
  clearCrashBreadcrumbsForTest()
})

describe('crash breadcrumb store', () => {
  it('keeps a fixed-size in-memory snapshot', () => {
    for (let index = 0; index < 32; index += 1) {
      recordCrashBreadcrumb(`event_${index}`, { index })
    }

    const snapshot = getCrashBreadcrumbSnapshot()

    expect(snapshot).toHaveLength(30)
    expect(snapshot[0].name).toBe('event_2')
    expect(snapshot[29].name).toBe('event_31')
  })

  it('retains bounded renderer high-water profiles across later activity', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
    recordCrashBreadcrumb('renderer_memory_highwater', {
      rendererSurface: 'main',
      thresholdPct: 80,
      'store.agentStatusByPaneKey': 500
    })
    for (let index = 0; index < 32; index += 1) {
      vi.advanceTimersByTime(60_000)
      recordCrashBreadcrumb('renderer_memory', { index })
    }

    const snapshot = getCrashBreadcrumbSnapshot()

    expect(snapshot).toHaveLength(30)
    expect(snapshot[0]).toEqual(
      expect.objectContaining({
        name: 'renderer_memory_highwater',
        data: expect.objectContaining({ thresholdPct: 80 })
      })
    )
    expect(snapshot.at(-1)?.data).toEqual({ index: 31 })
  })

  it('caps retained high-water profiles', () => {
    for (let index = 0; index < 5; index += 1) {
      recordCrashBreadcrumb('renderer_memory_highwater', {
        rendererSurface: `surface-${index}`,
        thresholdPct: 80
      })
    }

    expect(
      getCrashBreadcrumbSnapshot().map((breadcrumb) => breadcrumb.data?.rendererSurface)
    ).toEqual(['surface-1', 'surface-2', 'surface-3', 'surface-4'])
  })

  it('redacts sensitive breadcrumb fields before they can be snapshotted', () => {
    recordCrashBreadcrumb('workspace_opened', {
      path: '/Users/alice/project',
      token: 'ghp_abcdefghijklmnopqrstuvwxyz',
      ssh: true
    })

    expect(getCrashBreadcrumbSnapshot()[0].data).toEqual({
      path: '[redacted-path]',
      token: '[redacted-secret]',
      ssh: true
    })
  })

  it('returns a copy so callers cannot mutate the ring buffer', () => {
    recordCrashBreadcrumb('app_started', { packaged: false })

    const snapshot = getCrashBreadcrumbSnapshot()
    if (snapshot[0]?.data) {
      snapshot[0].data.packaged = true
    }
    snapshot.pop()

    expect(getCrashBreadcrumbSnapshot()).toHaveLength(1)
    expect(getCrashBreadcrumbSnapshot()[0].data).toEqual({ packaged: false })
  })

  it('coalesces repeated breadcrumbs inside the interval', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-20T12:00:00.000Z'))

    const first = recordCoalescedCrashBreadcrumb({
      name: 'agent_state_changed',
      data: { agentType: 'claude', state: 'working' },
      coalesceKey: 'agent:claude:working',
      minIntervalMs: 30_000
    })
    vi.advanceTimersByTime(1_000)
    const suppressed = recordCoalescedCrashBreadcrumb({
      name: 'agent_state_changed',
      data: { agentType: 'claude', state: 'working' },
      coalesceKey: 'agent:claude:working',
      minIntervalMs: 30_000
    })
    vi.advanceTimersByTime(30_000)
    const resumed = recordCoalescedCrashBreadcrumb({
      name: 'agent_state_changed',
      data: { agentType: 'claude', state: 'working' },
      coalesceKey: 'agent:claude:working',
      minIntervalMs: 30_000
    })

    expect(first).toEqual({ suppressedSinceLast: 0 })
    expect(suppressed).toBeUndefined()
    expect(resumed).toEqual({ suppressedSinceLast: 1 })
    expect(getCrashBreadcrumbSnapshot().map((entry) => entry.data)).toEqual([
      { agentType: 'claude', state: 'working' },
      { agentType: 'claude', state: 'working', suppressedSinceLast: 1 }
    ])

    vi.useRealTimers()
  })
})
