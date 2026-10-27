import { describe, expect, it } from 'vitest'
import { withFolderWorkspacesLast } from './folder-workspace-lane-order'
import type { Worktree } from './workspace-list-types'

function row(worktreeId: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    workspaceKind: 'git',
    worktreeId,
    repoId: 'repo-1',
    repo: 'orca',
    branch: '',
    displayName: worktreeId,
    path: `/tmp/${worktreeId}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null,
    agents: [],
    ...overrides
  }
}

describe('withFolderWorkspacesLast', () => {
  it('lists folder workspaces after the worktrees, by user rank then name, like desktop', () => {
    const folder = { workspaceKind: 'folder-workspace' as const }
    const rows = [
      row('folder:low', { ...folder, displayName: 'b', sortOrder: 1 }),
      row('git'),
      row('folder:tie', { ...folder, displayName: 'a', sortOrder: 1 }),
      row('folder:high', { ...folder, displayName: 'c', sortOrder: 5 })
    ]
    expect(withFolderWorkspacesLast(rows).map((w) => w.worktreeId)).toEqual([
      'git',
      'folder:high',
      'folder:tie',
      'folder:low'
    ])
  })
})
