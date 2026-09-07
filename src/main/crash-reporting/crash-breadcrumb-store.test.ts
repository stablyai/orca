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
    for (let index = 0; index < 9; index += 1) {
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
      'surface-8'
    ])
  })

  it('retains both threshold ladders for both renderer surfaces', () => {
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
    }

    expect(
      getCrashBreadcrumbSnapshot().map((breadcrumb) => [
        breadcrumb.data?.rendererSurface,
        breadcrumb.data?.thresholdPct ?? breadcrumb.data?.thresholdPrivateMB
      ])
    ).toEqual([
      ['main', 60],
      ['main', 80],
      ['main', 600],
      ['main', 1000],
      ['dashboard-popout', 60],
      ['dashboard-popout', 80],
      ['dashboard-popout', 600],
      ['dashboard-popout', 1000]
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

  // Windows crash F0BKR84AHEH: two `terminal_safe_fit_retry_exhausted` bursts
  // (34 crumbs in 76ms, 34 in 56ms) flushed the pre-crash trail out of a
  // 30-entry ring. Every hidden pane is display:none, so it measures 0x0, fails
  // the fit thresholds, and burns its whole retry budget — one reattach wave
  // fires once per mounted pane, near-simultaneously. These two cases pin the
  // before/after so the coalescing in crash-reporting.ts cannot silently regress.
  describe('a per-pane burst against the fixed-size ring', () => {
    const recordPreCrashTrail = (): void => {
      for (let index = 0; index < 10; index += 1) {
        recordCrashBreadcrumb(`pre_crash_evidence_${index}`, { index })
      }
    }
    const burstSize = 34

    it('erases the entire pre-crash trail when uncoalesced', () => {
      recordPreCrashTrail()
      for (let pane = 0; pane < burstSize; pane += 1) {
        recordCrashBreadcrumb('terminal_safe_fit_retry_exhausted', { paneId: 1 })
      }

      const snapshot = getCrashBreadcrumbSnapshot()

      expect(snapshot.filter((entry) => entry.name.startsWith('pre_crash_evidence_'))).toHaveLength(
        0
      )
      expect(
        snapshot.filter((entry) => entry.name === 'terminal_safe_fit_retry_exhausted')
      ).toHaveLength(30)
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
      // The population survives even though 33 crumbs did not — that count was
      // the only signal the multiplicity ever carried.
      expect(bursts[0].data).toEqual(
        expect.objectContaining({ livePanes: burstSize, livePaneManagers: burstSize })
      )
    })

    // The suppression path returns before the delete-then-set that re-anchors
    // recency, so a continuously-suppressed key kept its original insertion slot
    // and became the FIRST eviction candidate — the exact inverse of the LRU's
    // intent. `renderer_error` keys carry message+stack identity, so one noisy
    // loop mints unbounded distinct keys and evicts the burst key mid-storm,
    // re-arming the ring flush this suppression exists to prevent.
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

      // Assert on suppression, not on ring occupancy: 200 genuinely-distinct
      // errors legitimately flush the 30-entry ring, which masks an eviction as
      // "one entry" either way.
      expect(reEmissions).toBe(0)
      expect(hitBurstKey()).toBeUndefined()
    })

    // Re-anchoring must move position only. Renewing recordedAt on every hit
    // would let a sustained emitter suppress itself forever and never re-emit.
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

    // Panes mount progressively, so the first crumb of a burst sees a census of
    // 1. Freezing it would report `livePanes: 1` for a 34-pane wave — the exact
    // "one pane looping" misread that coalescing by name was built to prevent.
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

    // The re-emitted crumb already carries `suppressedSinceLast`, so folding the
    // same events into the expiring slot too would report one burst twice.
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

    // A crash report filed mid-window snapshots the ring, which folds the
    // suppressed repeats into the emitted crumb. Re-claiming those repeats on
    // the next emit would report one burst twice across two crumbs.
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

      // The re-emitted crumb was born claiming nothing, so a fold onto it must
      // claim only the new repeat — not the one the first crumb already owns.
      vi.advanceTimersByTime(10)
      hit(4)
      const resolved = getCrashBreadcrumbSnapshot().filter(
        (entry) => entry.name === 'terminal_safe_fit_retry_exhausted'
      )
      expect(resolved[1].data).toEqual({ livePanes: 4, suppressedSinceLast: 1 })
    })

    // A re-emitted crumb is born already claiming the previous window's count;
    // a later fold must add to that claim, not overwrite it away.
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

    // A crash storm records other breadcrumbs too; if they push the burst crumb
    // out of the 30-entry ring mid-window, a snapshot's fold lands in evidence
    // no snapshot can see. Marking those repeats resolved anyway would let the
    // next emit claim nothing and the burst vanish from the record entirely.
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

    // Retained high-water profiles occupy snapshot slots, so the oldest ring
    // entries past that budget are invisible to every future snapshot even
    // though they are still in the array; folding there loses the burst too.
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
      // Ring stays at 30 (burst crumb still at index 0) but only the newest 26
      // ring entries fit a snapshot alongside the 4 retained profiles.
      for (let index = 0; index < 29; index += 1) {
        recordCrashBreadcrumb(`renderer_error_${index}`, { index })
      }
      getCrashBreadcrumbSnapshot()
      vi.advanceTimersByTime(31_000)
      const resumed = hit(4)

      expect(resumed).toEqual({ suppressedSinceLast: 2 })
    })

    // Two crash reports filed inside one window are immutable cumulative views;
    // the next window must still start from zero unresolved debt.
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

      // A fold onto the fresh crumb must claim only its own window's repeat —
      // over-resolving in the first window would push this claim negative.
      vi.advanceTimersByTime(10)
      hit(6)
      const resolved = getCrashBreadcrumbSnapshot().filter(
        (entry) => entry.name === 'terminal_safe_fit_retry_exhausted'
      )
      expect(resolved[1].data).toEqual({ livePanes: 6, suppressedSinceLast: 1 })
    })

    // A key that ages out loses its only handle on the ring entry it owns, so
    // the newest suppressed payload must be folded in before the entry is
    // dropped from the map.
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
