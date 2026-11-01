import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  recordCoalescedCrashBreadcrumb,
  clearCrashBreadcrumbsForTest,
  getCoalescedKeyCountForTest
} from './crash-breadcrumb-store'

// MAX_COALESCE_KEYS is module-private; mirror its value here.
const MAX_COALESCE_KEYS = 128

describe('coalescedBreadcrumbs stays bounded (leak regression)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    clearCrashBreadcrumbsForTest()
  })

  afterEach(() => {
    clearCrashBreadcrumbsForTest()
    vi.useRealTimers()
  })

  it('caps the map even with an unbounded stream of distinct agentType keys', () => {
    // Hold time fixed so expiry cannot relieve the size-cap pressure.
    for (let i = 0; i < 1000; i++) {
      recordCoalescedCrashBreadcrumb({
        name: 'agent_state',
        coalesceKey: `agent:type-${i}:working`,
        minIntervalMs: 30_000
      })
    }
    expect(getCoalescedKeyCountForTest()).toBeLessThanOrEqual(MAX_COALESCE_KEYS)
  })
})
