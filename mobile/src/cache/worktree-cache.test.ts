import { describe, expect, it } from 'vitest'
import { setCachedWorktrees, getCachedWorktrees, getProvenCachedWorktrees } from './worktree-cache'

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

// Only live worktree.ps can prove absence for Resume redirects; persisted cold-start seeds must never be authoritative (F7).
describe('worktree-cache provenance', () => {
  it('withholds unmarked writes from the proven reader', () => {
    const hostId = 'host-seeded'
    const seeded = [{ worktreeId: 'a' }]

    setCachedWorktrees(hostId, seeded)

    expect(getCachedWorktrees(hostId)).toEqual(seeded)
    expect(getProvenCachedWorktrees(hostId)).toBeNull()
  })

  it('exposes a host-listed catalog to the proven reader', () => {
    const hostId = 'host-proven'
    const listed = [{ worktreeId: 'a' }, { worktreeId: 'b' }]

    setCachedWorktrees(hostId, listed, { proven: true })

    expect(getProvenCachedWorktrees(hostId)).toEqual(listed)
  })

  it('keeps a fresh proven catalog when an unproven seed lands after it', () => {
    const hostId = 'host-kept'
    const listed = [{ worktreeId: 'a' }, { worktreeId: 'b' }]
    setCachedWorktrees(hostId, listed, { proven: true })

    // A cold-start snapshot seed must neither truncate nor de-prove the host-listed rows.
    setCachedWorktrees(hostId, [{ worktreeId: 'a' }])

    expect(getProvenCachedWorktrees(hostId)).toEqual(listed)
  })

  it('lets an unproven seed replace another unproven entry', () => {
    const hostId = 'host-reseeded'
    setCachedWorktrees(hostId, [{ worktreeId: 'a' }])
    setCachedWorktrees(hostId, [{ worktreeId: 'b' }])

    expect(getCachedWorktrees(hostId)).toEqual([{ worktreeId: 'b' }])
    expect(getProvenCachedWorktrees(hostId)).toBeNull()
  })

  it('reports nothing proven for a host it has never cached', () => {
    expect(getProvenCachedWorktrees('host-never-seen')).toBeNull()
  })
})
