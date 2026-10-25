import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearCrashBreadcrumbsForTest,
  getCrashBreadcrumbSnapshot,
  RENDERER_HEAP_ALLOCATION_PROFILE_BREADCRUMB,
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

  describe('fair-share eviction', () => {
    it('spends the overflow on the most repeated series, not the oldest event', () => {
      recordCrashBreadcrumb('app_started', { packaged: true })
      recordCrashBreadcrumb('main_window_created')
      recordCrashBreadcrumb('main_window_loaded')
      for (let sample = 0; sample < 200; sample += 1) {
        recordCrashBreadcrumb('renderer_memory', { sample })
      }

      const snapshot = getCrashBreadcrumbSnapshot()

      expect(snapshot.map((entry) => entry.name).slice(0, 3)).toEqual([
        'app_started',
        'main_window_created',
        'main_window_loaded'
      ])
      expect(snapshot.filter((entry) => entry.name === 'renderer_memory')).toHaveLength(27)
    })

    it('thins the crowded series from its oldest end, keeping the run before the crash', () => {
      recordCrashBreadcrumb('app_started')
      for (let sample = 0; sample < 200; sample += 1) {
        recordCrashBreadcrumb('renderer_memory', { sample })
      }

      const samples = getCrashBreadcrumbSnapshot()
        .filter((entry) => entry.name === 'renderer_memory')
        .map((entry) => entry.data?.sample)

      expect(samples.at(-1)).toBe(199)
      expect(samples).toEqual(
        Array.from({ length: samples.length }, (_, i) => 200 - samples.length + i)
      )
    })

    it('splits the ring between two competing series', () => {
      for (let round = 0; round < 100; round += 1) {
        recordCrashBreadcrumb('renderer_memory', { round })
        recordCrashBreadcrumb('pr_refresh_queue', { round })
      }

      const snapshot = getCrashBreadcrumbSnapshot()

      expect(snapshot.filter((entry) => entry.name === 'renderer_memory')).toHaveLength(15)
      expect(snapshot.filter((entry) => entry.name === 'pr_refresh_queue')).toHaveLength(15)
    })

    it('does not evict a coalescing owner that still holds unfolded repeats', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-14T12:00:00.000Z'))
      const hit = (key: string): void => {
        recordCoalescedCrashBreadcrumb({
          name: 'renderer_error',
          data: { key },
          coalesceKey: key,
          minIntervalMs: 30_000
        })
      }

      recordCrashBreadcrumb('app_started')
      hit('hot')
      vi.advanceTimersByTime(10)
      for (let repeat = 0; repeat < 5; repeat += 1) {
        hit('hot')
      }
      // Distinct keys crowd one name without coalescing away the eviction pressure.
      for (let index = 0; index < 40; index += 1) {
        vi.advanceTimersByTime(10)
        hit(`cold_${index}`)
      }

      const snapshot = getCrashBreadcrumbSnapshot()
      const hotCrumb = snapshot.find((entry) => entry.data?.key === 'hot')

      expect(snapshot.some((entry) => entry.name === 'app_started')).toBe(true)
      expect(hotCrumb?.data?.suppressedSinceLast).toBe(5)
    })

    it('protects the trail when three series share the ring, none holding a majority', () => {
      recordCrashBreadcrumb('app_started')
      recordCrashBreadcrumb('main_window_created')
      recordCrashBreadcrumb('main_window_loaded')
      for (let round = 0; round < 100; round += 1) {
        recordCrashBreadcrumb('renderer_memory', { round })
        recordCrashBreadcrumb('agent_state_changed', { round })
        recordCrashBreadcrumb('pr_refresh_queue', { round })
      }

      const snapshot = getCrashBreadcrumbSnapshot()

      expect(snapshot.slice(0, 3).map((entry) => entry.name)).toEqual([
        'app_started',
        'main_window_created',
        'main_window_loaded'
      ])
    })

    it('charges the overflow to a name holding only two slots', () => {
      for (let index = 0; index < 15; index += 1) {
        recordCrashBreadcrumb(`single_${index}`)
      }
      recordCrashBreadcrumb('duplicated', { first: true })
      for (let index = 15; index < 29; index += 1) {
        recordCrashBreadcrumb(`single_${index}`)
      }
      recordCrashBreadcrumb('duplicated', { first: false })

      const snapshot = getCrashBreadcrumbSnapshot()

      expect(snapshot[0].name).toBe('single_0')
      expect(snapshot.filter((entry) => entry.name === 'duplicated')).toHaveLength(1)
    })

    it('counts the entry that just arrived when two series are tied', () => {
      recordCrashBreadcrumb('lifecycle_a')
      recordCrashBreadcrumb('lifecycle_b')
      for (let index = 0; index < 14; index += 1) {
        recordCrashBreadcrumb('series_b', { index })
      }
      for (let index = 0; index < 14; index += 1) {
        recordCrashBreadcrumb('series_a', { index })
      }
      recordCrashBreadcrumb('series_a', { index: 14 })

      const snapshot = getCrashBreadcrumbSnapshot()

      expect(snapshot.filter((entry) => entry.name === 'series_a')).toHaveLength(14)
      expect(snapshot.filter((entry) => entry.name === 'series_b')).toHaveLength(14)
    })

    it("does not let one renderer surface evict another surface's only sample", () => {
      for (let index = 0; index < 15; index += 1) {
        recordCrashBreadcrumb(`lifecycle_${index}`, undefined, 'main')
      }
      recordCrashBreadcrumb('renderer_memory', { surface: 'main' }, 'main')
      for (let index = 15; index < 29; index += 1) {
        recordCrashBreadcrumb(`lifecycle_${index}`, undefined, 'main')
      }
      recordCrashBreadcrumb('renderer_memory', { surface: 'popout' }, 'popout')

      const mainSnapshot = getCrashBreadcrumbSnapshot('main')

      expect(mainSnapshot.filter((entry) => entry.name === 'renderer_memory')).toHaveLength(1)
    })

    it('charges the crowded group even when all of its entries are live owners', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-14T12:00:00.000Z'))
      recordCrashBreadcrumb('app_started')
      for (let index = 0; index < 30; index += 1) {
        const hit = (): void => {
          recordCoalescedCrashBreadcrumb({
            name: 'renderer_error',
            data: { index },
            coalesceKey: `key_${index}`,
            minIntervalMs: 30_000
          })
        }
        hit()
        hit()
      }

      const snapshot = getCrashBreadcrumbSnapshot()

      expect(snapshot.some((entry) => entry.name === 'app_started')).toBe(true)
      expect(snapshot.some((entry) => entry.data?.index === 29)).toBe(true)
    })

    it('keeps the lifecycle trail when the retained lane takes part of the budget', () => {
      // Separate timestamps so snapshot sorting tests policy rather than tie-breaking.
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-14T12:00:00.000Z'))
      const tick = (): void => {
        vi.advanceTimersByTime(1_000)
      }
      recordCrashBreadcrumb('app_started')
      tick()
      recordCrashBreadcrumb('main_window_created')
      tick()
      recordCrashBreadcrumb('main_window_loaded')
      for (let mark = 0; mark < 3; mark += 1) {
        tick()
        recordCrashBreadcrumb('renderer_memory_highwater', {
          rendererSurface: 'main',
          thresholdPrivateMB: 600 + mark
        })
      }
      for (let sample = 0; sample < 200; sample += 1) {
        tick()
        recordCrashBreadcrumb('renderer_memory', { sample })
      }

      const snapshot = getCrashBreadcrumbSnapshot()
      const names = snapshot.map((entry) => entry.name)

      expect(snapshot).toHaveLength(30)
      expect(names.filter((name) => name === 'renderer_memory_highwater')).toHaveLength(3)
      expect(names.slice(0, 3)).toEqual([
        'app_started',
        'main_window_created',
        'main_window_loaded'
      ])
    })

    // Owner visibility must use the same fair-eviction window as the final snapshot.
    it('folds a burst into an owner the report keeps, even when the lane takes budget', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-14T12:00:00.000Z'))
      for (let mark = 0; mark < 3; mark += 1) {
        recordCrashBreadcrumb('renderer_memory_highwater', {
          rendererSurface: 'main',
          thresholdPrivateMB: 600 + mark
        })
      }
      recordCrashBreadcrumb('app_started')
      const hit = (): void => {
        recordCoalescedCrashBreadcrumb({
          name: 'renderer_error',
          data: { message: 'boom' },
          coalesceKey: 'boom',
          minIntervalMs: 30_000
        })
      }
      hit()
      for (let repeat = 0; repeat < 5; repeat += 1) {
        vi.advanceTimersByTime(10)
        hit()
      }
      for (let sample = 0; sample < 200; sample += 1) {
        vi.advanceTimersByTime(10)
        recordCrashBreadcrumb('renderer_memory', { sample })
      }

      const snapshot = getCrashBreadcrumbSnapshot()
      const owner = snapshot.find((entry) => entry.name === 'renderer_error')

      expect(owner?.data?.suppressedSinceLast).toBe(5)
    })

    it('degenerates to oldest-first when no name repeats', () => {
      for (let index = 0; index < 40; index += 1) {
        recordCrashBreadcrumb(`event_${index}`)
      }

      const snapshot = getCrashBreadcrumbSnapshot()

      expect(snapshot[0].name).toBe('event_10')
      expect(snapshot[29].name).toBe('event_39')
    })
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
    for (let index = 0; index < 11; index += 1) {
      recordCrashBreadcrumb('renderer_memory_highwater', {
        rendererSurface: `surface-${index}`,
        thresholdPct: 80
      })
    }

    expect(
      getCrashBreadcrumbSnapshot().map((breadcrumb) => breadcrumb.data?.rendererSurface)
    ).toEqual([
      'surface-1',
      'surface-2',
      'surface-3',
      'surface-4',
      'surface-5',
      'surface-6',
      'surface-7',
      'surface-8',
      'surface-9',
      'surface-10'
    ])
  })

  it('retains both threshold ladders and the allocation profile for both renderer surfaces', () => {
    for (const rendererSurface of ['main', 'dashboard-popout']) {
      for (const thresholdPct of [60, 80]) {
        recordCrashBreadcrumb('renderer_memory_highwater', { rendererSurface, thresholdPct })
      }
      for (const thresholdPrivateMB of [600, 1000]) {
        recordCrashBreadcrumb('renderer_memory_highwater', {
          rendererSurface,
          thresholdPrivateMB
        })
      }
      recordCrashBreadcrumb(RENDERER_HEAP_ALLOCATION_PROFILE_BREADCRUMB, { rendererSurface })
    }

    expect(
      getCrashBreadcrumbSnapshot().map((breadcrumb) => [
        breadcrumb.data?.rendererSurface,
        breadcrumb.data?.thresholdPct ?? breadcrumb.data?.thresholdPrivateMB ?? breadcrumb.name
      ])
    ).toEqual([
      ['main', 60],
      ['main', 80],
      ['main', 600],
      ['main', 1000],
      ['main', RENDERER_HEAP_ALLOCATION_PROFILE_BREADCRUMB],
      ['dashboard-popout', 60],
      ['dashboard-popout', 80],
      ['dashboard-popout', 600],
      ['dashboard-popout', 1000],
      ['dashboard-popout', RENDERER_HEAP_ALLOCATION_PROFILE_BREADCRUMB]
    ])
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

  it('expires the coalescing window after a backward wall-clock step', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-20T12:00:00.000Z'))
    const hit = (): { suppressedSinceLast: number } | undefined =>
      recordCoalescedCrashBreadcrumb({
        name: 'agent_state_changed',
        coalesceKey: 'agent:claude:working',
        minIntervalMs: 30_000
      })

    hit()
    vi.advanceTimersByTime(10_000)
    expect(hit()).toBeUndefined()
    vi.setSystemTime(new Date('2025-05-20T12:00:00.000Z'))
    vi.advanceTimersByTime(20_000)

    expect(hit()).toEqual({ suppressedSinceLast: 1 })
    expect(getCrashBreadcrumbSnapshot()).toHaveLength(2)
  })

  it('does not collapse the coalescing window after a forward wall-clock step', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-20T12:00:00.000Z'))
    const hit = (): { suppressedSinceLast: number } | undefined =>
      recordCoalescedCrashBreadcrumb({
        name: 'agent_state_changed',
        coalesceKey: 'agent:claude:working',
        minIntervalMs: 30_000
      })

    hit()
    vi.advanceTimersByTime(10_000)
    vi.setSystemTime(new Date('2027-05-20T12:00:00.000Z'))

    expect(hit()).toBeUndefined()
    vi.advanceTimersByTime(20_000)
    expect(hit()).toEqual({ suppressedSinceLast: 1 })
  })

  it('folds data-less repeats into the emitted breadcrumb', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-20T12:00:00.000Z'))

    recordCoalescedCrashBreadcrumb({
      name: 'terminal_safe_fit_retry_exhausted',
      coalesceKey: 'terminal_safe_fit_retry_exhausted',
      minIntervalMs: 30_000
    })
    recordCoalescedCrashBreadcrumb({
      name: 'terminal_safe_fit_retry_exhausted',
      coalesceKey: 'terminal_safe_fit_retry_exhausted',
      minIntervalMs: 30_000
    })

    expect(getCrashBreadcrumbSnapshot()[0]?.data).toEqual({ suppressedSinceLast: 1 })
  })

  describe('a per-pane burst against the fixed-size ring', () => {
    const recordPreCrashTrail = (): void => {
      for (let index = 0; index < 10; index += 1) {
        recordCrashBreadcrumb(`pre_crash_evidence_${index}`, { index })
      }
    }
    const burstSize = 34

    it('takes most of the ring when uncoalesced, but no longer erases the trail', () => {
      recordPreCrashTrail()
      for (let pane = 0; pane < burstSize; pane += 1) {
        recordCrashBreadcrumb('terminal_safe_fit_retry_exhausted', { paneId: 1 })
      }

      const snapshot = getCrashBreadcrumbSnapshot()

      const bursts = snapshot.filter((entry) => entry.name === 'terminal_safe_fit_retry_exhausted')

      expect(snapshot.filter((entry) => entry.name.startsWith('pre_crash_evidence_'))).toHaveLength(
        10
      )
      expect(bursts).toHaveLength(20)
      expect(bursts.some((entry) => entry.data?.livePanes !== undefined)).toBe(false)
      expect(bursts.every((entry) => entry.data?.suppressedSinceLast === undefined)).toBe(true)
    })

    it('costs one slot when coalesced, and keeps the pane count on the payload', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
      recordPreCrashTrail()
      for (let pane = 0; pane < burstSize; pane += 1) {
        vi.advanceTimersByTime(2)
        recordCoalescedCrashBreadcrumb({
          name: 'terminal_safe_fit_retry_exhausted',
          data: {
            paneId: 1,
            leafId: `2222222${pane}-2222-4222-8222-222222222222`,
            livePanes: burstSize,
            livePaneManagers: burstSize
          },
          coalesceKey: 'terminal_safe_fit_retry_exhausted',
          minIntervalMs: 30_000
        })
      }

      const snapshot = getCrashBreadcrumbSnapshot()
      const bursts = snapshot.filter((entry) => entry.name === 'terminal_safe_fit_retry_exhausted')

      expect(snapshot.filter((entry) => entry.name.startsWith('pre_crash_evidence_'))).toHaveLength(
        10
      )
      expect(bursts).toHaveLength(1)
      expect(bursts[0].data).toEqual(
        expect.objectContaining({ livePanes: burstSize, livePaneManagers: burstSize })
      )
    })

    it('keeps suppressing a hot key while high-cardinality churn fills the LRU', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
      const hitBurstKey = (): { suppressedSinceLast: number } | undefined =>
        recordCoalescedCrashBreadcrumb({
          name: 'terminal_safe_fit_retry_exhausted',
          data: { livePanes: burstSize },
          coalesceKey: 'terminal_safe_fit_retry_exhausted',
          minIntervalMs: 30_000
        })

      hitBurstKey()
      let reEmissions = 0
      for (let index = 0; index < 200; index += 1) {
        vi.advanceTimersByTime(10)
        recordCoalescedCrashBreadcrumb({
          name: 'renderer_error',
          data: { message: `error-${index}` },
          coalesceKey: `renderer_error:error-${index}`,
          minIntervalMs: 30_000
        })
        if (hitBurstKey() !== undefined) {
          reEmissions += 1
        }
      }

      // Check suppression: ring occupancy alone can hide an evicted key's re-emission.
      expect(reEmissions).toBe(0)
      expect(hitBurstKey()).toBeUndefined()
    })

    it('still expires the suppression window while a hot key is re-anchored', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
      const hit = (): { suppressedSinceLast: number } | undefined =>
        recordCoalescedCrashBreadcrumb({
          name: 'terminal_safe_fit_retry_exhausted',
          data: {},
          coalesceKey: 'terminal_safe_fit_retry_exhausted',
          minIntervalMs: 30_000
        })

      hit()
      for (let index = 0; index < 29; index += 1) {
        vi.advanceTimersByTime(1_000)
        expect(hit()).toBeUndefined()
      }
      vi.advanceTimersByTime(1_000)

      expect(hit()).toEqual({ suppressedSinceLast: 29 })
    })

    it('reports the newest census of a growing burst, not the first', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
      for (let pane = 1; pane <= burstSize; pane += 1) {
        vi.advanceTimersByTime(2)
        recordCoalescedCrashBreadcrumb({
          name: 'terminal_safe_fit_retry_exhausted',
          data: {
            paneId: 1,
            leafId: `3333333${pane}-3333-4333-8333-333333333333`,
            livePanes: pane,
            livePaneManagers: pane
          },
          coalesceKey: 'terminal_safe_fit_retry_exhausted',
          minIntervalMs: 30_000
        })
      }

      const bursts = getCrashBreadcrumbSnapshot().filter(
        (entry) => entry.name === 'terminal_safe_fit_retry_exhausted'
      )

      expect(bursts).toHaveLength(1)
      expect(bursts[0].data).toEqual(
        expect.objectContaining({
          livePanes: burstSize,
          livePaneManagers: burstSize,
          leafId: `3333333${burstSize}-3333-4333-8333-333333333333`,
          suppressedSinceLast: burstSize - 1
        })
      )
    })

    it('counts a burst once when the window expires and the key re-emits', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
      const hit = (livePanes: number): void => {
        recordCoalescedCrashBreadcrumb({
          name: 'terminal_safe_fit_retry_exhausted',
          data: { livePanes },
          coalesceKey: 'terminal_safe_fit_retry_exhausted',
          minIntervalMs: 30_000
        })
      }

      hit(1)
      vi.advanceTimersByTime(10)
      hit(2)
      vi.advanceTimersByTime(31_000)
      hit(3)

      const bursts = getCrashBreadcrumbSnapshot().filter(
        (entry) => entry.name === 'terminal_safe_fit_retry_exhausted'
      )

      expect(bursts).toHaveLength(2)
      expect(bursts[0].data).toEqual({ livePanes: 1 })
      expect(bursts[1].data).toEqual({ livePanes: 3, suppressedSinceLast: 1 })
    })

    it('does not re-claim repeats a snapshot already folded into the crumb', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
      const hit = (livePanes: number): { suppressedSinceLast: number } | undefined =>
        recordCoalescedCrashBreadcrumb({
          name: 'terminal_safe_fit_retry_exhausted',
          data: { livePanes },
          coalesceKey: 'terminal_safe_fit_retry_exhausted',
          minIntervalMs: 30_000
        })

      hit(1)
      vi.advanceTimersByTime(10)
      hit(2)
      getCrashBreadcrumbSnapshot()
      vi.advanceTimersByTime(31_000)
      const resumed = hit(3)

      expect(resumed).toEqual({ suppressedSinceLast: 0 })
      const bursts = getCrashBreadcrumbSnapshot().filter(
        (entry) => entry.name === 'terminal_safe_fit_retry_exhausted'
      )
      expect(bursts[0].data).toEqual({ livePanes: 2, suppressedSinceLast: 1 })
      expect(bursts[1].data).toEqual({ livePanes: 3 })

      vi.advanceTimersByTime(10)
      hit(4)
      const resolved = getCrashBreadcrumbSnapshot().filter(
        (entry) => entry.name === 'terminal_safe_fit_retry_exhausted'
      )
      expect(resolved[1].data).toEqual({ livePanes: 4, suppressedSinceLast: 1 })
    })

    it('keeps the carried count when a fold resolves onto a re-emitted crumb', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
      const hit = (livePanes: number): void => {
        recordCoalescedCrashBreadcrumb({
          name: 'terminal_safe_fit_retry_exhausted',
          data: { livePanes },
          coalesceKey: 'terminal_safe_fit_retry_exhausted',
          minIntervalMs: 30_000
        })
      }

      hit(1)
      vi.advanceTimersByTime(10)
      hit(2)
      vi.advanceTimersByTime(31_000)
      hit(3)
      vi.advanceTimersByTime(10)
      hit(4)

      const bursts = getCrashBreadcrumbSnapshot().filter(
        (entry) => entry.name === 'terminal_safe_fit_retry_exhausted'
      )
      expect(bursts[1].data).toEqual({ livePanes: 4, suppressedSinceLast: 2 })
    })

    it('re-claims repeats on the next emit when the burst crumb was evicted from the ring', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
      const hit = (livePanes: number): { suppressedSinceLast: number } | undefined =>
        recordCoalescedCrashBreadcrumb({
          name: 'terminal_safe_fit_retry_exhausted',
          data: { livePanes },
          coalesceKey: 'terminal_safe_fit_retry_exhausted',
          minIntervalMs: 30_000
        })

      hit(1)
      vi.advanceTimersByTime(10)
      hit(2)
      hit(3)
      for (let index = 0; index < 30; index += 1) {
        recordCrashBreadcrumb(`renderer_error_${index}`, { index })
      }
      getCrashBreadcrumbSnapshot()
      vi.advanceTimersByTime(31_000)
      const resumed = hit(4)

      expect(resumed).toEqual({ suppressedSinceLast: 2 })
      const burst = getCrashBreadcrumbSnapshot().find(
        (entry) => entry.name === 'terminal_safe_fit_retry_exhausted'
      )
      expect(burst?.data).toEqual({ livePanes: 4, suppressedSinceLast: 2 })
    })

    it('re-claims repeats when retained profiles push the burst crumb past the snapshot budget', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
      const hit = (livePanes: number): { suppressedSinceLast: number } | undefined =>
        recordCoalescedCrashBreadcrumb({
          name: 'terminal_safe_fit_retry_exhausted',
          data: { livePanes },
          coalesceKey: 'terminal_safe_fit_retry_exhausted',
          minIntervalMs: 30_000
        })

      hit(1)
      vi.advanceTimersByTime(10)
      hit(2)
      hit(3)
      for (let index = 0; index < 4; index += 1) {
        recordCrashBreadcrumb('renderer_memory_highwater', {
          rendererSurface: `surface-${index}`,
          thresholdPct: 80
        })
      }
      // Four retained profiles reduce the report's ring budget to 26 entries.
      for (let index = 0; index < 29; index += 1) {
        recordCrashBreadcrumb(`renderer_error_${index}`, { index })
      }
      getCrashBreadcrumbSnapshot()
      vi.advanceTimersByTime(31_000)
      const resumed = hit(4)

      expect(resumed).toEqual({ suppressedSinceLast: 2 })
    })

    it('keeps immutable snapshots cumulative without re-claiming resolved debt', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
      const hit = (livePanes: number): { suppressedSinceLast: number } | undefined =>
        recordCoalescedCrashBreadcrumb({
          name: 'terminal_safe_fit_retry_exhausted',
          data: { livePanes },
          coalesceKey: 'terminal_safe_fit_retry_exhausted',
          minIntervalMs: 30_000
        })

      hit(1)
      vi.advanceTimersByTime(10)
      hit(2)
      hit(3)
      const firstSnapshot = getCrashBreadcrumbSnapshot()
      vi.advanceTimersByTime(10)
      hit(4)
      const secondFold = getCrashBreadcrumbSnapshot().find(
        (entry) => entry.name === 'terminal_safe_fit_retry_exhausted'
      )
      expect(firstSnapshot[0]?.data).toEqual({ livePanes: 3, suppressedSinceLast: 2 })
      expect(secondFold?.data).toEqual({ livePanes: 4, suppressedSinceLast: 3 })

      vi.advanceTimersByTime(31_000)
      const resumed = hit(5)
      expect(resumed).toEqual({ suppressedSinceLast: 0 })

      vi.advanceTimersByTime(10)
      hit(6)
      const resolved = getCrashBreadcrumbSnapshot().filter(
        (entry) => entry.name === 'terminal_safe_fit_retry_exhausted'
      )
      expect(resolved[1].data).toEqual({ livePanes: 6, suppressedSinceLast: 1 })
    })

    it('resolves a suppressed payload when an unrelated key ages the map', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
      recordCoalescedCrashBreadcrumb({
        name: 'terminal_park_verdict_churn',
        data: { livePanes: 1 },
        coalesceKey: 'terminal_park_verdict_churn',
        minIntervalMs: 30_000
      })
      vi.advanceTimersByTime(10)
      recordCoalescedCrashBreadcrumb({
        name: 'terminal_park_verdict_churn',
        data: { livePanes: 9 },
        coalesceKey: 'terminal_park_verdict_churn',
        minIntervalMs: 30_000
      })
      vi.advanceTimersByTime(31_000)
      recordCoalescedCrashBreadcrumb({
        name: 'terminal_safe_fit_retry_exhausted',
        data: { livePanes: 2 },
        coalesceKey: 'terminal_safe_fit_retry_exhausted',
        minIntervalMs: 30_000
      })

      const churn = getCrashBreadcrumbSnapshot().find(
        (entry) => entry.name === 'terminal_park_verdict_churn'
      )

      expect(churn?.data).toEqual({ livePanes: 9, suppressedSinceLast: 1 })
    })
  })
})
