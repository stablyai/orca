import { describe, expect, it } from 'vitest'
import { setCachedWorktrees, getCachedWorktrees, getProvenCachedWorktrees } from './worktree-cache'

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

// Why (F7): home seeds this cache from a persisted cold-start snapshot as well as from a live
// worktree.ps, and only the latter can prove a workspace *absent* — the Resume tap redirects
// off that distinction, so a seeded entry must never look authoritative.
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
