import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearCrashBreadcrumbsForTest,
  getCrashBreadcrumbSnapshot,
  recordCoalescedCrashBreadcrumb,
  recordCrashBreadcrumb
} from './crash-breadcrumb-store'

const COALESCE_WINDOW_MS = 30_000
const MAX_COALESCE_KEYS = 128
const ORPHAN_KEY = 'terminal_safe_fit_retry_exhausted'

function recordOrphanCandidate(livePanes: number): void {
  recordCoalescedCrashBreadcrumb({
    name: ORPHAN_KEY,
    data: { livePanes },
    coalesceKey: ORPHAN_KEY,
    minIntervalMs: COALESCE_WINDOW_MS
  })
}

function resumeOrphanCandidate(livePanes: number): { suppressedSinceLast: number } | undefined {
  return recordCoalescedCrashBreadcrumb({
    name: ORPHAN_KEY,
    data: { livePanes },
    coalesceKey: ORPHAN_KEY,
    minIntervalMs: COALESCE_WINDOW_MS
  })
}

function recordSuppressedBurst(): void {
  recordOrphanCandidate(1)
  recordOrphanCandidate(2)
  recordOrphanCandidate(3)
}

function orphanFromRing(): void {
  for (let index = 0; index < 30; index += 1) {
    recordCrashBreadcrumb(`renderer_error_${index}`, { index })
  }
  getCrashBreadcrumbSnapshot()
}

function orphanFromSnapshotBudget(): void {
  for (let index = 0; index < 4; index += 1) {
    recordCrashBreadcrumb('renderer_memory_highwater', {
      rendererSurface: `surface-${index}`,
      thresholdPct: 80
    })
  }
  for (let index = 0; index < 29; index += 1) {
    recordCrashBreadcrumb(`renderer_error_${index}`, { index })
  }
  getCrashBreadcrumbSnapshot()
}

function expireWithUnrelatedKey(): void {
  vi.advanceTimersByTime(COALESCE_WINDOW_MS + 1)
  recordCoalescedCrashBreadcrumb({
    name: 'agent_state_changed',
    data: { agentType: 'claude', state: 'working' },
    coalesceKey: 'agent:claude:working',
    minIntervalMs: COALESCE_WINDOW_MS
  })
}

function evictWithUnrelatedKeys(): void {
  for (let index = 0; index < MAX_COALESCE_KEYS; index += 1) {
    recordCoalescedCrashBreadcrumb({
      name: 'renderer_error',
      data: { message: `error-${index}` },
      coalesceKey: `renderer_error:error-${index}`,
      minIntervalMs: COALESCE_WINDOW_MS
    })
  }
}

function expectSuppressedBurstPreserved(): void {
  const recovered = getCrashBreadcrumbSnapshot().find(
    (breadcrumb) => breadcrumb.name === ORPHAN_KEY && breadcrumb.data?.suppressedSinceLast === 2
  )
  expect(recovered?.data).toEqual({ livePanes: 3, suppressedSinceLast: 2 })
}

describe('orphaned coalesced breadcrumb cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
  })

  afterEach(() => {
    clearCrashBreadcrumbsForTest()
    vi.useRealTimers()
  })

  it('preserves ring-orphaned repeats through unrelated expiry cleanup', () => {
    recordSuppressedBurst()
    orphanFromRing()

    expireWithUnrelatedKey()

    expectSuppressedBurstPreserved()
  })

  it('preserves data-less repeats through orphan cleanup', () => {
    for (let index = 0; index < 3; index += 1) {
      recordCoalescedCrashBreadcrumb({
        name: ORPHAN_KEY,
        coalesceKey: ORPHAN_KEY,
        minIntervalMs: COALESCE_WINDOW_MS
      })
    }
    orphanFromRing()

    expireWithUnrelatedKey()

    const recovered = getCrashBreadcrumbSnapshot().find(
      (breadcrumb) => breadcrumb.name === ORPHAN_KEY
    )
    expect(recovered?.data).toEqual({ suppressedSinceLast: 2 })
  })

  it('preserves snapshot-budget-orphaned repeats through unrelated expiry cleanup', () => {
    recordSuppressedBurst()
    orphanFromSnapshotBudget()

    expireWithUnrelatedKey()

    expectSuppressedBurstPreserved()
  })

  it('preserves ring-orphaned repeats through LRU cleanup', () => {
    recordSuppressedBurst()
    orphanFromRing()

    evictWithUnrelatedKeys()

    expectSuppressedBurstPreserved()
  })

  it('preserves snapshot-budget-orphaned repeats through LRU cleanup', () => {
    recordSuppressedBurst()
    orphanFromSnapshotBudget()

    evictWithUnrelatedKeys()

    expectSuppressedBurstPreserved()
  })

  it('materializes only repeats not already claimed by an earlier snapshot', () => {
    recordOrphanCandidate(1)
    recordOrphanCandidate(2)
    const firstSnapshot = getCrashBreadcrumbSnapshot()
    recordOrphanCandidate(3)
    recordOrphanCandidate(4)
    orphanFromRing()

    expireWithUnrelatedKey()

    expect(firstSnapshot[0]?.data).toEqual({ livePanes: 2, suppressedSinceLast: 1 })
    const recovered = getCrashBreadcrumbSnapshot().find(
      (breadcrumb) => breadcrumb.name === ORPHAN_KEY
    )
    expect(recovered?.data).toEqual({ livePanes: 4, suppressedSinceLast: 2 })
    expect(resumeOrphanCandidate(5)).toEqual({ suppressedSinceLast: 0 })
  })
})
