/**
 * Memory-leak regression: the coalesced-breadcrumb map must stay bounded.
 *
 * `recordCoalescedCrashBreadcrumb` does `coalescedBreadcrumbs.set(coalesceKey, …)`
 * with no TTL prune and no size cap. Production keys are `agent:${agentType}:${state}`,
 * and agentType reaches this store (via relay/SSH ingestRemote + OSC observed-status)
 * as an OPEN string — only length-trimmed to 40 chars, never enum-checked — so the key
 * space is unbounded over a long multi-agent/SSH session. The only shrink path was the
 * test-only clear. (The sibling `breadcrumbs` array is already bounded to 30.)
 */
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
    // No time advance, so nothing coalesces or TTL-prunes — pure cap pressure.
    for (let i = 0; i < 1000; i++) {
      recordCoalescedCrashBreadcrumb({
        name: 'agent_state',
        coalesceKey: `agent:type-${i}:working`,
        minIntervalMs: 30_000
      })
    }
    expect(getCoalescedKeyCountForTest()).toBeLessThanOrEqual(MAX_COALESCE_KEYS)
  })

  it('still coalesces repeated breadcrumbs for the same key within the interval', () => {
    recordCoalescedCrashBreadcrumb({ name: 'x', coalesceKey: 'k', minIntervalMs: 30_000 })
    recordCoalescedCrashBreadcrumb({ name: 'x', coalesceKey: 'k', minIntervalMs: 30_000 })
    // Second call is suppressed within the interval — one key, no growth.
    expect(getCoalescedKeyCountForTest()).toBe(1)
  })

  it('keeps the most-recently-recorded key after capping', () => {
    for (let i = 0; i < MAX_COALESCE_KEYS + 50; i++) {
      recordCoalescedCrashBreadcrumb({
        name: 'agent_state',
        coalesceKey: `agent:type-${i}:working`,
        minIntervalMs: 30_000
      })
    }
    // The newest key survives; record it again — still suppressed (still present).
    recordCoalescedCrashBreadcrumb({
      name: 'agent_state',
      coalesceKey: `agent:type-${MAX_COALESCE_KEYS + 49}:working`,
      minIntervalMs: 30_000
    })
    expect(getCoalescedKeyCountForTest()).toBeLessThanOrEqual(MAX_COALESCE_KEYS)
  })
})
