import { describe, expect, it } from 'vitest'
import {
  getCachedWorktrees,
  getCachedWorkspaceCatalog,
  getProvenCachedWorktrees,
  setCachedWorktrees
} from './worktree-cache'
import type { Worktree } from '../worktree/workspace-list-types'

function summary(worktreeId: string, displayName = worktreeId) {
  return {
    worktreeId,
    repo: 'orca',
    branch: 'main',
    displayName,
    liveTerminalCount: 0
  }
}

function workspace(worktreeId: string): Worktree {
  return {
    worktreeId,
    repoId: 'repo-1',
    repo: 'orca',
    branch: 'main',
    displayName: worktreeId,
    path: `/tmp/${worktreeId}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    preview: '',
    unread: false,
    isPinned: false,
    linkedPR: null
  }
}

// Why: AC #8498 guarantees a reconnect refetch writes through the
// same cache path the host detail screen seeds from, so a reconnect can't
// serve a stale snapshot. This unit pins the write-through contract.
describe('worktree-cache write-through', () => {
  it('returns the most-recently written snapshot, not a stale one', () => {
    const hostId = 'host-write-through'
    const stale = [summary('a', 'stale')]
    const fresh = [summary('a', 'fresh'), summary('b', 'added')]

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
    setCachedWorktrees(hostId, [summary('old', 'pre-reconnect')])

    // Reconnect refetch lands a fresh snapshot and writes it through.
    const reconnected = [summary('old', 'post-reconnect'), summary('new', 'now-visible')]
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
    const seeded = [summary('a')]

    setCachedWorktrees(hostId, seeded)

    expect(getCachedWorktrees(hostId)).toEqual(seeded)
    expect(getProvenCachedWorktrees(hostId)).toBeNull()
  })

  it('exposes a host-listed catalog to the proven reader', () => {
    const hostId = 'host-proven'
    const listed = [summary('a'), summary('b')]

    setCachedWorktrees(hostId, listed, { proven: true })

    expect(getProvenCachedWorktrees(hostId)).toEqual(listed)
  })

  it('keeps a fresh proven catalog when an unproven seed lands after it', () => {
    const hostId = 'host-kept'
    const listed = [summary('a'), summary('b')]
    setCachedWorktrees(hostId, listed, { proven: true })

    // A cold-start snapshot seed must neither truncate nor de-prove the host-listed rows.
    setCachedWorktrees(hostId, [summary('a')])

    expect(getProvenCachedWorktrees(hostId)).toEqual(listed)
  })

  it('lets an unproven seed replace another unproven entry', () => {
    const hostId = 'host-reseeded'
    setCachedWorktrees(hostId, [summary('a')])
    setCachedWorktrees(hostId, [summary('b')])

    expect(getCachedWorktrees(hostId)).toEqual([summary('b')])
    expect(getProvenCachedWorktrees(hostId)).toBeNull()
  })

  it('keeps a valid summary entry when the full-catalog reader cannot use it', () => {
    const hostId = 'host-summary-shape'
    const seeded = [summary('a')]
    setCachedWorktrees(hostId, seeded)

    expect(getCachedWorkspaceCatalog(hostId)).toBeNull()
    expect(getCachedWorktrees(hostId)).toEqual(seeded)
  })

  it('reports nothing proven for a host it has never cached', () => {
    expect(getProvenCachedWorktrees('host-never-seen')).toBeNull()
  })

  it('keeps a safe full catalog when a malformed full payload tries to replace it', () => {
    const hostId = 'host-poisoned'
    const safe = workspace('safe')
    setCachedWorktrees(hostId, [safe], { proven: true })

    setCachedWorktrees(hostId, [
      { ...workspace('poison'), linkedPR: { number: '7', state: 'open' } }
    ])

    expect(getCachedWorkspaceCatalog(hostId)).toEqual([safe])
  })
})
