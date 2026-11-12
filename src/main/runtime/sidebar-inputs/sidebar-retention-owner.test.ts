import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../shared/worktree/types'
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
    /** False until the workspaces producer's first scan applied. */
    scanned: boolean
  } = {
    showSleeping: false,
    worktrees,
    active: new Set(),
    tabsOpen: new Set(),
    scanned: true
  }
  const rowsChanged = new Set<() => void>()
  const owner = new SidebarRetentionOwner(new SidebarClock(), {
    showSleepingWorkspaces: () => world.showSleeping,
    rowKeys: () => (world.scanned ? world.worktrees.map(getWorktreeHostIdentity) : null),
    watchRowKeys: (changed) => {
      rowsChanged.add(changed)
      return () => rowsChanged.delete(changed)
    },
    retentionCandidates: () => ({
      isActive: (id) => world.active.has(id),
      isUnverifiableGap: (id) => world.tabsOpen.has(id)
    })
  })
  const bumpRows = (): void => rowsChanged.forEach((changed) => changed())
  return { world, owner, bumpRows, rowsChanged }
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

  it('gives each host’s row of a same-id pair its own grace window', async () => {
    const local = worktree('a', { hostId: 'local' })
    const { world, owner, bumpRows } = harness([local])
    owner.beginSession('s1')
    await flush()
    world.active = new Set(['a'])
    world.tabsOpen = new Set(['a'])
    owner.noteActivityChange()
    world.active = new Set()
    owner.noteActivityChange()
    // A twin listed only after the id went idle was never seen live, so it earns no grace.
    world.worktrees = [local, worktree('a', { hostId: 'ssh:box' })]
    bumpRows()
    await flush()
    expect(owner.snapshot().retention?.retainedIds).toEqual(['local|a'])
  })
})
