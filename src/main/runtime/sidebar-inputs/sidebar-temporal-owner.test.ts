import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../shared/worktree/types'
import type { WorkspaceSortBy } from '../../../shared/workspace-view/workspace-row-sort'
import { CREATE_GRACE_MS } from '../../../shared/workspace-view/workspace-row-sort'
import { SORT_SETTLE_MS } from '../../../shared/sidebar-list/sort-settle'
import { SLEEPING_SWEEP_SETTLE_MS } from '../../../shared/sidebar-list/sleeping-sweep-retention'
import type { SmartSortSources } from '../../../shared/sidebar-list/smart-sort'
import {
  getWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import { SidebarClock } from './sidebar-clock'
import { SidebarTemporalOwner } from './sidebar-temporal-owner'

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

const NO_SOURCES: SmartSortSources = {
  tabsByWorktree: {},
  agentStatusByPaneKey: {},
  runtimePaneTitlesByTabId: {},
  ptyIdsByTabId: {}
}

type World = {
  sortBy: WorkspaceSortBy
  showSleeping: boolean
  worktrees: Worktree[]
  sources: SmartSortSources
  active: Set<string>
  tabsOpen: Set<string>
  gate: Promise<void> | null
}

function harness(initial: { sortBy: WorkspaceSortBy; worktrees: Worktree[] }) {
  const world: World = {
    sortBy: initial.sortBy,
    showSleeping: false,
    worktrees: initial.worktrees,
    sources: NO_SOURCES,
    active: new Set<string>(),
    tabsOpen: new Set<string>(),
    gate: null
  }
  const owner = new SidebarTemporalOwner(new SidebarClock(), {
    sortBy: () => world.sortBy,
    showSleepingWorkspaces: () => world.showSleeping,
    readSortSample: async () => {
      const worktrees = world.worktrees
      await world.gate
      return { worktrees, repoMap: new Map(), sources: world.sources }
    },
    retentionCandidates: () => ({
      ids: world.active,
      isActive: (id) => world.active.has(id),
      isUnverifiableGap: (id) => world.tabsOpen.has(id)
    })
  })
  const ranked = (): string[] | undefined =>
    owner.snapshot().sortSnapshot?.rankedIds.map(getWorktreeIdFromHostIdentity)
  return { world, owner, ranked }
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

describe('SidebarTemporalOwner', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces a burst into one re-sort three seconds after its last change', async () => {
    const { world, owner, ranked } = harness({
      sortBy: 'recent',
      worktrees: [worktree('a', { lastActivityAt: 2 }), worktree('b', { lastActivityAt: 1 })]
    })
    owner.beginSession('s1')
    await flush()
    expect(ranked()).toEqual(['a', 'b'])

    world.worktrees = [worktree('a', { lastActivityAt: 2 }), worktree('b', { lastActivityAt: 3 })]
    owner.noteSortInputChange()
    await vi.advanceTimersByTimeAsync(2_000)
    owner.noteSortInputChange()
    await vi.advanceTimersByTimeAsync(SORT_SETTLE_MS - 1)
    expect(ranked()).toEqual(['a', 'b'])
    await vi.advanceTimersByTimeAsync(1)
    expect(ranked()).toEqual(['b', 'a'])
    expect(owner.snapshot().sortSnapshot?.epoch).toBe(2)
  })

  it('settles at once when the row count moves or the mode switches', async () => {
    const { world, owner, ranked } = harness({ sortBy: 'name', worktrees: [worktree('b')] })
    owner.beginSession('s1')
    await flush()
    world.worktrees = [worktree('b'), worktree('a')]
    owner.noteCatalogListing(world.worktrees, false)
    await flush()
    expect(ranked()).toEqual(['a', 'b'])

    world.worktrees = [worktree('b', { lastActivityAt: 9 }), worktree('a')]
    world.sortBy = 'recent'
    owner.noteViewChange()
    await flush()
    expect(owner.snapshot().sortSnapshot?.mode).toBe('recent')
    expect(ranked()).toEqual(['b', 'a'])
  })

  it('keeps Smart cold on saved order until a live signal, then latched until a new session', async () => {
    const { world, owner, ranked } = harness({
      sortBy: 'smart',
      worktrees: [
        worktree('a', { sortOrder: 2, lastActivityAt: 1 }),
        worktree('b', { sortOrder: 1, lastActivityAt: 5 })
      ]
    })
    owner.beginSession('s1')
    await flush()
    expect(ranked()).toEqual(['a', 'b'])
    expect(owner.snapshot().sortSnapshot?.smartLatched).toBe(false)

    world.sources = {
      ...NO_SOURCES,
      tabsByWorktree: { b: [{ id: 'tab-b', title: 'zsh' }] },
      ptyIdsByTabId: { 'tab-b': ['pty-b'] }
    }
    owner.noteSortInputChange()
    await vi.advanceTimersByTimeAsync(SORT_SETTLE_MS)
    expect(ranked()).toEqual(['b', 'a'])
    expect(owner.snapshot().sortSnapshot?.smartLatched).toBe(true)

    // The signal ending does not unlatch: recency still ranks b first.
    world.sources = NO_SOURCES
    owner.noteSortInputChange()
    await vi.advanceTimersByTimeAsync(SORT_SETTLE_MS)
    expect(ranked()).toEqual(['b', 'a'])

    owner.beginSession('s2')
    expect(owner.snapshot()).toMatchObject({ sessionId: 's2', sortSnapshot: null })
    await flush()
    expect(ranked()).toEqual(['a', 'b'])
    expect(owner.snapshot().sortSnapshot?.smartLatched).toBe(false)
  })

  it('re-sorts when a new workspace leaves its Recent create grace', async () => {
    const now = Date.now()
    const { owner, ranked } = harness({
      sortBy: 'recent',
      worktrees: [
        worktree('old', { lastActivityAt: now - 10 }),
        worktree('new', { lastActivityAt: now - 1_000, createdAt: now - 1_000 })
      ]
    })
    owner.beginSession('s1')
    await flush()
    expect(ranked()).toEqual(['new', 'old'])
    await vi.advanceTimersByTimeAsync(CREATE_GRACE_MS - 1_000)
    expect(ranked()).toEqual(['old', 'new'])
    expect(owner.snapshot().sortSnapshot?.cause).toBe('create-grace')
  })

  it('stays idle until a window begins a session, and after dispose', async () => {
    const { world, owner } = harness({ sortBy: 'name', worktrees: [worktree('a')] })
    owner.noteCatalogListing([worktree('a')], false)
    owner.noteSortInputChange()
    world.active = new Set(['a'])
    owner.noteActivityChange()
    await vi.advanceTimersByTimeAsync(SORT_SETTLE_MS)
    expect(owner.snapshot()).toEqual({
      revision: 0,
      sessionId: null,
      sortSnapshot: null,
      retention: null
    })
    expect(vi.getTimerCount()).toBe(0)

    owner.beginSession('s1')
    owner.dispose()
    owner.noteSortInputChange()
    await vi.advanceTimersByTimeAsync(SORT_SETTLE_MS)
    expect(owner.snapshot().sortSnapshot).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('takes the session catalog as its row baseline, so a later listing waits out the burst', async () => {
    const { world, owner, ranked } = harness({
      sortBy: 'recent',
      worktrees: [worktree('a', { lastActivityAt: 2 }), worktree('b', { lastActivityAt: 1 })]
    })
    owner.beginSession('s1')
    await flush()
    // A bump with no row count, then a listing with the same rows and fresher activity.
    owner.noteSortInputChange()
    world.worktrees = [worktree('a', { lastActivityAt: 2 }), worktree('b', { lastActivityAt: 3 })]
    owner.noteCatalogListing(world.worktrees, false)
    await flush()
    expect(ranked()).toEqual(['a', 'b'])
    await vi.advanceTimersByTimeAsync(SORT_SETTLE_MS)
    expect(ranked()).toEqual(['b', 'a'])

    // A listing that changed nothing the sort reads is no bump, so it cannot delay a settle.
    world.worktrees = [worktree('a', { lastActivityAt: 4 }), worktree('b', { lastActivityAt: 3 })]
    owner.noteSortInputChange()
    await vi.advanceTimersByTimeAsync(SORT_SETTLE_MS - 1_000)
    owner.noteCatalogListing(
      [worktree('a', { lastActivityAt: 2 }), worktree('b', { lastActivityAt: 3 })],
      false
    )
    await vi.advanceTimersByTimeAsync(1_000)
    expect(ranked()).toEqual(['a', 'b'])
  })

  it('reads a sortOrder-only save and a repo change as writes that never restart the burst', async () => {
    const rows = (sortOrder: number): Worktree[] => [
      worktree('a', { lastActivityAt: 2, sortOrder }),
      worktree('b', { lastActivityAt: 1 })
    ]
    const { world, owner } = harness({ sortBy: 'recent', worktrees: rows(0) })
    const epoch = (): number | undefined => owner.snapshot().sortSnapshot?.epoch
    owner.beginSession('s1')
    await flush()
    owner.noteSortInputChange()
    await vi.advanceTimersByTimeAsync(2_000)
    world.worktrees = rows(5)
    owner.noteCatalogListing(world.worktrees, false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(epoch()).toBe(2)

    // A repo edit re-sorts at once and arms nothing.
    owner.noteCatalogListing(world.worktrees, true)
    await flush()
    expect(epoch()).toBe(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('takes a listing that lands before the first sample as the baseline', async () => {
    const { world, owner } = harness({ sortBy: 'recent', worktrees: [worktree('a')] })
    let release: () => void = () => {}
    world.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    owner.beginSession('s1')
    world.worktrees = [worktree('a'), worktree('b')]
    owner.noteCatalogListing(world.worktrees, false)
    world.gate = null
    release()
    await flush()
    expect(owner.snapshot().sortSnapshot?.epoch).toBe(1)
    // Same count as the baseline, so a later row change waits out the burst.
    owner.noteCatalogListing([worktree('a'), worktree('b', { lastActivityAt: 7 })], false)
    await flush()
    expect(owner.snapshot().sortSnapshot?.epoch).toBe(1)
    await vi.advanceTimersByTimeAsync(SORT_SETTLE_MS)
    expect(owner.snapshot().sortSnapshot?.epoch).toBe(2)
  })

  it('drops a sample a newer settle overtook', async () => {
    const { world, owner, ranked } = harness({ sortBy: 'name', worktrees: [worktree('a')] })
    // The session's first read stalls on the one-row catalog; a mode switch's read overtakes it.
    let release: () => void = () => {}
    world.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    owner.beginSession('s1')
    world.gate = null
    world.worktrees = [worktree('a'), worktree('b')]
    world.sortBy = 'recent'
    owner.noteViewChange()
    await flush()
    expect(ranked()).toEqual(['a', 'b'])
    release()
    await flush()
    expect(ranked()).toEqual(['a', 'b'])
  })

  it('holds a live row through a rebind gap, then lets it go on its own deadline', async () => {
    const { world, owner } = harness({ sortBy: 'name', worktrees: [worktree('a'), worktree('b')] })
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
})
