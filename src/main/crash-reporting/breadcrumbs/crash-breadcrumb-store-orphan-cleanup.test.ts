import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearCrashBreadcrumbsForTest,
  getCrashBreadcrumbSnapshot,
  recordCoalescedCrashBreadcrumb,
  recordCrashBreadcrumb
} from './crash-breadcrumb-store'

const COALESCE_WINDOW_MS = 30_000

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

function orphanFromRing(): void {
  for (let index = 0; index < 30; index += 1) {
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

describe('orphaned coalesced breadcrumb cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
  })

  afterEach(() => {
    clearCrashBreadcrumbsForTest()
    vi.useRealTimers()
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
