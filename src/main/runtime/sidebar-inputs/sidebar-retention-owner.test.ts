import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../shared/worktree/types'
import { SLEEPING_SWEEP_SETTLE_MS } from '../../../shared/sidebar-list/sleeping-sweep-retention'
import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import { SidebarClock } from './sidebar-clock'
import { SidebarRetentionOwner } from './sidebar-retention-owner'

function worktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    repoId: 'repo-1',
    path: `/tmp/${id}`,
    head: 'abc',
    branch: `refs/heads/${id}`,
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function harness(worktrees: Worktree[]) {
  const world: {
    showSleeping: boolean
    worktrees: Worktree[]
    active: Set<string>
    tabsOpen: Set<string>
    /** When set, the next listing waits for its own release. */
    holdNextListing: boolean
    releases: (() => void)[]
  } = {
    showSleeping: false,
    worktrees,
    active: new Set(),
    tabsOpen: new Set(),
    holdNextListing: false,
    releases: []
  }
  const owner = new SidebarRetentionOwner(new SidebarClock(), {
    showSleepingWorkspaces: () => world.showSleeping,
    listRowKeys: async () => {
      const rows = world.worktrees
      if (world.holdNextListing) {
        world.holdNextListing = false
        await new Promise<void>((resolve) => world.releases.push(resolve))
      }
      return rows.map(getWorktreeHostIdentity)
    },
    retentionCandidates: () => ({
      isActive: (id) => world.active.has(id),
      isUnverifiableGap: (id) => world.tabsOpen.has(id)
    })
  })
  return { world, owner }
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

describe('SidebarRetentionOwner', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stays idle until a window begins a session, and after dispose', async () => {
    const { world, owner } = harness([worktree('a')])
    owner.noteCatalogChange()
    world.active = new Set(['a'])
    owner.noteActivityChange()
    await flush()
    expect(owner.snapshot()).toEqual({ revision: 0, sessionId: null, retention: null })
    expect(vi.getTimerCount()).toBe(0)

    owner.beginSession('s1')
    owner.dispose()
    owner.noteActivityChange()
    await flush()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('holds a live row through a rebind gap, then lets it go on its own deadline', async () => {
    const { world, owner } = harness([worktree('a'), worktree('b')])
    owner.beginSession('s1')
    await flush()
    world.active = new Set(['a', 'b'])
    world.tabsOpen = new Set(['a'])
    owner.noteActivityChange()
    world.active = new Set()
    owner.noteActivityChange()
    // b had no terminal tab left, so its inactivity is definitive and gets no grace.
    expect(owner.snapshot().retention?.retainedIds).toEqual([
      getWorktreeHostIdentity(worktree('a'))
    ])
    await vi.advanceTimersByTimeAsync(SLEEPING_SWEEP_SETTLE_MS)
    expect(owner.snapshot().retention?.retainedIds).toEqual([])

    world.showSleeping = true
    owner.noteViewChange()
    expect(owner.snapshot().retention).toBeNull()
  })

  it('publishes nothing until a listing lands, then host-qualifies from the newest one', async () => {
    const remote = worktree('a', { hostId: 'ssh:box' })
    const { world, owner } = harness([])
    // The session's own listing is slow and read no rows.
    world.holdNextListing = true
    owner.beginSession('s1')
    world.active = new Set(['a'])
    world.tabsOpen = new Set(['a'])
    owner.noteActivityChange()
    expect(owner.snapshot().retention).toBeNull()

    // A catalog change lists again, and that newer listing lands first.
    world.worktrees = [remote]
    const before = owner.snapshot().revision
    owner.noteCatalogChange()
    await flush()
    // Readers learn that retention is now published.
    expect(owner.snapshot().revision).toBeGreaterThan(before)
    world.active = new Set()
    owner.noteActivityChange()
    expect(owner.snapshot().retention?.retainedIds).toEqual([getWorktreeHostIdentity(remote)])

    world.releases.forEach((release) => release())
    await flush()
    expect(owner.snapshot().retention?.retainedIds).toEqual([getWorktreeHostIdentity(remote)])
  })

  it('retains every host’s row of a same-id pair, as this host’s session is by bare id', async () => {
    const local = worktree('a', { hostId: 'local' })
    const remote = worktree('a', { hostId: 'ssh:box' })
    const { world, owner } = harness([local, remote])
    owner.beginSession('s1')
    await flush()
    world.active = new Set(['a'])
    world.tabsOpen = new Set(['a'])
    owner.noteActivityChange()
    world.active = new Set()
    owner.noteActivityChange()
    expect(owner.snapshot().retention?.retainedIds).toEqual(['local|a', 'ssh:box|a'])
  })

  it('gives each host’s row of a same-id pair its own grace window', async () => {
    const local = worktree('a', { hostId: 'local' })
    const { world, owner } = harness([local])
    owner.beginSession('s1')
    await flush()
    world.active = new Set(['a'])
    world.tabsOpen = new Set(['a'])
    owner.noteActivityChange()
    world.active = new Set()
    owner.noteActivityChange()
    // A twin listed only after the id went idle was never seen live, so it earns no grace.
    world.worktrees = [local, worktree('a', { hostId: 'ssh:box' })]
    owner.noteCatalogChange()
    await flush()
    expect(owner.snapshot().retention?.retainedIds).toEqual(['local|a'])
  })
})
