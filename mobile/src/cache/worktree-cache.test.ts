import { describe, expect, it } from 'vitest'
import { setCachedWorktrees, getCachedWorktrees } from './worktree-cache'

// Why: AC #8498 guarantees a reconnect refetch writes through the
// same cache path the host detail screen seeds from, so a reconnect can't
// serve a stale snapshot. This unit pins the write-through contract.
describe('worktree-cache write-through', () => {
  it('returns the most-recently written snapshot, not a stale one', () => {
    const hostId = 'host-write-through'
    const stale = [{ worktreeId: 'a', name: 'stale' }]
    const fresh = [
      { worktreeId: 'a', name: 'fresh' },
      { worktreeId: 'b', name: 'added' }
    ]

    setCachedWorktrees(hostId, stale)
    expect(getCachedWorktrees(hostId)).toEqual(stale)

    // Why: simulates the reconnect refetch write-through — the fresh
    // worktree.ps snapshot must fully replace the poisoned cache entry.
    setCachedWorktrees(hostId, fresh)
    expect(getCachedWorktrees(hostId)).toEqual(fresh)
    expect(getCachedWorktrees(hostId)).not.toEqual(stale)
  })

  it('exposes a fresh snapshot to a remounting screen after reconnect', () => {
    // Why: the host detail screen reads getCachedWorktrees(hostId)
    // on (re)mount as its initialCache. A reconnect that writes
    // through must therefore surface here instead of the pre-reconnect data.
    const hostId = 'host-remount'
    setCachedWorktrees(hostId, [{ worktreeId: 'old', name: 'pre-reconnect' }])

    // Reconnect refetch lands a fresh snapshot and writes it through.
    const reconnected = [
      { worktreeId: 'old', name: 'post-reconnect' },
      { worktreeId: 'new', name: 'now-visible' }
    ]
    setCachedWorktrees(hostId, reconnected)

    // A fresh screen mount reads the cache — must see the connected set.
    expect(getCachedWorktrees(hostId)).toEqual(reconnected)
  })
})
