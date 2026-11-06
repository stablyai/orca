import { describe, expect, it } from 'vitest'
import { setCachedWorktrees, getCachedWorktrees } from './worktree-cache'

// Pin reconnect write-through to cache seeded by host detail (#8498), preventing stale reconnect snapshots.
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

    // Reconnect write-through must fully replace poisoned cache.
    setCachedWorktrees(hostId, fresh)
    expect(getCachedWorktrees(hostId)).toEqual(fresh)
    expect(getCachedWorktrees(hostId)).not.toEqual(stale)
  })
})

// A persisted cold-start seed must not truncate the rows a live worktree.ps listed.
describe('worktree-cache provenance', () => {
  it('keeps a fresh host-listed catalog when a cold-start seed lands after it', () => {
    const hostId = 'host-kept'
    const listed = [{ worktreeId: 'a' }, { worktreeId: 'b' }]
    setCachedWorktrees(hostId, listed, { proven: true })

    setCachedWorktrees(hostId, [{ worktreeId: 'a' }])

    expect(getCachedWorktrees(hostId)).toEqual(listed)
  })

  it('lets a seed replace another seed', () => {
    const hostId = 'host-reseeded'
    setCachedWorktrees(hostId, [{ worktreeId: 'a' }])
    setCachedWorktrees(hostId, [{ worktreeId: 'b' }])

    expect(getCachedWorktrees(hostId)).toEqual([{ worktreeId: 'b' }])
  })
})
