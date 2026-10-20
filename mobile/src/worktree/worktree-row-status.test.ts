import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Worktree } from './workspace-list-types'
import { getWorktreeStatus } from './worktree-row-status'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  const worktreePath = join('/tmp', 'orca', 'worktrees', 'feature')
  return {
    workspaceKind: 'git',
    worktreeId: `repo-1::${worktreePath}`,
    repoId: 'repo-1',
    repo: 'orca',
    branch: 'feature/mobile-parity',
    displayName: 'feature',
    path: worktreePath,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null,
    status: 'inactive',
    agents: [],
    ...overrides
  }
}

describe('getWorktreeStatus', () => {
  it('uses host sidebar inactivity for the row status dot when available', () => {
    expect(
      getWorktreeStatus(
        worktree({
          status: 'active',
          liveTerminalCount: 3,
          hasHostSidebarActivity: false
        })
      )
    ).toBe('inactive')
  })

  it('marks host sidebar activity active when runtime status has not caught up', () => {
    expect(
      getWorktreeStatus(
        worktree({
          status: 'inactive',
          liveTerminalCount: 0,
          hasHostSidebarActivity: true
        })
      )
    ).toBe('active')
  })
})
