import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../shared/worktree/types'
import type { WorkspaceSortBy } from '../../../shared/workspace-view/workspace-row-sort'
import { CREATE_GRACE_MS } from '../../../shared/workspace-view/workspace-row-sort'
import { getWorktreeIdFromHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import { SidebarClock } from './sidebar-clock'
import { SidebarTemporalOwner } from './sidebar-temporal-owner'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

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

function harness(sortBy: WorkspaceSortBy, initial: Worktree[]) {
  const world = { worktrees: initial }
  const owner = new SidebarTemporalOwner(new SidebarClock(), {
    sortBy: () => sortBy,
    showSleepingWorkspaces: () => false,
    readSortSample: async () => ({
      worktrees: world.worktrees,
      repoMap: new Map(),
      sources: {
        tabsByWorktree: {},
        agentStatusByPaneKey: {},
        runtimePaneTitlesByTabId: {},
        ptyIdsByTabId: {}
      }
    }),
    retentionCandidates: () => ({ ids: [], isActive: () => false, isUnverifiableGap: () => false })
  })
  const snapshot = () => owner.snapshot().sortSnapshot
  const ranked = () => snapshot()?.rankedIds.map(getWorktreeIdFromHostIdentity)
  return { world, owner, ranked, snapshot }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

describe('SidebarTemporalOwner with the switch on', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-sorts at once on any re-list, as the window does', async () => {
    const { world, owner, ranked } = harness('smart', [
      worktree('a', { lastActivityAt: 2 }),
      worktree('b', { lastActivityAt: 1 })
    ])
    owner.beginSession('s1')
    await flush()
    owner.noteCatalogListing(world.worktrees, false)
    await flush()
    expect(ranked()).toEqual(['a', 'b'])

    world.worktrees = [
      worktree('a', { lastActivityAt: 2 }),
      worktree('b', { lastActivityAt: 1, smartTier: 'needs-you', smartAt: 1 })
    ]
    owner.noteCatalogListing(world.worktrees, false)
    await flush()
    expect(ranked()).toEqual(['b', 'a'])
  })

  it('re-sorts at once on a saved write no catalog event announced', async () => {
    const { world, owner, ranked, snapshot } = harness('recent', [
      worktree('a', { lastActivityAt: 2 }),
      worktree('b', { lastActivityAt: 1 })
    ])
    owner.beginSession('s1')
    await flush()
    world.worktrees = [worktree('a', { lastActivityAt: 2 }), worktree('b', { lastActivityAt: 3 })]
    owner.noteRowsWritten()
    await flush()
    expect(ranked()).toEqual(['b', 'a'])
    expect(snapshot()?.cause).toBe('settle')
  })

  it('schedules no create grace: a new row ranks by its stamp alone', async () => {
    const { owner, snapshot } = harness('recent', [
      worktree('a', { lastActivityAt: 2 }),
      worktree('new', { createdAt: Date.now(), lastActivityAt: 1 })
    ])
    owner.beginSession('s1')
    await flush()
    const epoch = snapshot()?.epoch
    await vi.advanceTimersByTimeAsync(CREATE_GRACE_MS + 1)
    expect(snapshot()?.epoch).toBe(epoch)
    expect(snapshot()?.rankedIds.map(getWorktreeIdFromHostIdentity)).toEqual(['a', 'new'])
  })
})
