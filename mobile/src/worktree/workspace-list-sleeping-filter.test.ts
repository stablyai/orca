import { describe, expect, it } from 'vitest'
import { filterWorktrees, type FilterState, type Worktree } from './workspace-list-sections'

describe('workspace list sleeping and default-branch filters', () => {
  it('keeps an inactive workspace that still has unread output', () => {
    const unread = worktree({ worktreeId: 'unread', unread: true, status: 'inactive' })
    const quiet = worktree({ worktreeId: 'quiet', unread: false, status: 'inactive' })

    expect(visibleIds([unread, quiet], { hideSleeping: true })).toEqual(['unread'])
  })

  it('sweeps a statusless workspace only when it has no live terminal', () => {
    const idle = worktree({ worktreeId: 'idle', status: undefined, liveTerminalCount: 0 })
    const running = worktree({ worktreeId: 'running', status: undefined, liveTerminalCount: 1 })

    expect(visibleIds([idle, running], { hideSleeping: true })).toEqual(['running'])
  })

  it('keeps a main worktree on a detached HEAD out of the default-branch sweep', () => {
    const detached = worktree({ worktreeId: 'detached', isMainWorktree: true, branch: '  ' })
    const onDefault = worktree({ worktreeId: 'default', isMainWorktree: true, branch: 'main' })

    expect(visibleIds([detached, onDefault], { hideDefaultBranch: true })).toEqual(['detached'])
  })
})

function visibleIds(worktrees: Worktree[], overrides: Partial<FilterState>): string[] {
  const filters: FilterState = {
    filterRepoIds: new Set(),
    hideSleeping: false,
    hideDefaultBranch: false,
    // Off, so "Hide sleeping" is decided by activity rather than the entry-point exemption.
    alwaysShowDefaultBranch: false,
    ...overrides
  }
  return filterWorktrees(worktrees, filters, '').map((worktree) => worktree.worktreeId)
}

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    workspaceKind: 'git',
    worktreeId: 'repo-1::/tmp/orca/worktrees/feature',
    repoId: 'repo-1',
    repo: 'orca',
    branch: 'feature/mobile-parity',
    displayName: 'feature',
    path: '/tmp/orca/worktrees/feature',
    isMainWorktree: false,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    preview: '',
    unread: false,
    isPinned: false,
    linkedPR: null,
    status: 'inactive',
    agents: [],
    ...overrides
  }
}
