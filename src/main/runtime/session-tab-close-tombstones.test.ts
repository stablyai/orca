import { describe, expect, it } from 'vitest'
import {
  SESSION_TAB_CLOSE_TOMBSTONE_TTL_MS,
  SessionTabCloseTombstoneStore
} from './session-tab-close-tombstones'

describe('SessionTabCloseTombstoneStore', () => {
  it('reports recorded tab ids until the TTL expires', () => {
    const store = new SessionTabCloseTombstoneStore()
    store.record('wt-1', 'tab-a', 1_000)
    store.record('wt-1', 'tab-b', 2_000)

    expect(store.activeIds('wt-1', 2_000)).toEqual(['tab-a', 'tab-b'])
    expect(store.isTabTombstoned('wt-1', 'tab-a', 2_000)).toBe(true)

    // tab-a expires first; tab-b outlives it by its own record time.
    const justPastFirst = 1_000 + SESSION_TAB_CLOSE_TOMBSTONE_TTL_MS
    expect(store.activeIds('wt-1', justPastFirst)).toEqual(['tab-b'])
    expect(store.isTabTombstoned('wt-1', 'tab-a', justPastFirst)).toBe(false)
    expect(store.activeIds('wt-1', 2_000 + SESSION_TAB_CLOSE_TOMBSTONE_TTL_MS)).toEqual([])
  })

  it('re-recording refreshes the TTL', () => {
    const store = new SessionTabCloseTombstoneStore()
    store.record('wt-1', 'tab-a', 1_000)
    store.record('wt-1', 'tab-a', 20_000)

    expect(store.isTabTombstoned('wt-1', 'tab-a', 1_000 + SESSION_TAB_CLOSE_TOMBSTONE_TTL_MS)).toBe(
      true
    )
    expect(
      store.isTabTombstoned('wt-1', 'tab-a', 20_000 + SESSION_TAB_CLOSE_TOMBSTONE_TTL_MS)
    ).toBe(false)
  })

  it('isolates tombstones per worktree', () => {
    const store = new SessionTabCloseTombstoneStore()
    store.record('wt-1', 'tab-a', 1_000)
    store.recordPty('wt-1', 'pty-1', 1_000)

    expect(store.activeIds('wt-2', 1_000)).toEqual([])
    expect(store.isTabTombstoned('wt-2', 'tab-a', 1_000)).toBe(false)
    expect(store.isPtyTombstoned('wt-2', 'pty-1', 1_000)).toBe(false)
    expect(store.isPtyTombstoned('wt-1', 'pty-1', 1_000)).toBe(true)
  })

  it('tracks pty tombstones independently of tab tombstones', () => {
    const store = new SessionTabCloseTombstoneStore()
    store.recordPty('wt-1', 'pty-1', 1_000)

    // A pty tombstone never leaks into recentlyClosedTabIds.
    expect(store.activeIds('wt-1', 1_000)).toEqual([])
    expect(store.isPtyTombstoned('wt-1', 'pty-1', 1_000)).toBe(true)
    expect(store.isPtyTombstoned('wt-1', 'pty-1', 1_000 + SESSION_TAB_CLOSE_TOMBSTONE_TTL_MS)).toBe(
      false
    )
  })
})
