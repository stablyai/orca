import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'
import {
  findFolderWorkspaceRow,
  getFolderAttachedWorktrees
} from './mobile-folder-attached-worktrees'

function worktree(overrides: Partial<Worktree>): Worktree {
  return {
    workspaceKind: 'git',
    worktreeId: 'worktree',
    repoId: 'repo-1',
    repo: 'api',
    branch: 'feature',
    displayName: 'worktree',
    path: '/tmp/worktree',
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null,
    ...overrides
  }
}

const folder = worktree({
  workspaceKind: 'folder-workspace',
  worktreeId: 'folder:f-1',
  repoId: 'folder-project:group-1'
})
const attachedTo = (worktreeId: `folder:${string}`) => ({
  workspaceLineage: { parentWorkspaceKey: worktreeId, parentInstanceId: 'f-1' }
})

describe('getFolderAttachedWorktrees', () => {
  it("lists the folder's children and their worktree descendants, oldest first", () => {
    const web = worktree({ worktreeId: 'web', createdAt: 20, ...attachedTo('folder:f-1') })
    const api = worktree({ worktreeId: 'api', createdAt: 10, ...attachedTo('folder:f-1') })
    const apiChild = worktree({ worktreeId: 'api-child', createdAt: 30, parentWorktreeId: 'api' })
    const archived = worktree({
      worktreeId: 'archived',
      createdAt: 5,
      isArchived: true,
      ...attachedTo('folder:f-1')
    })
    const other = worktree({ worktreeId: 'other', ...attachedTo('folder:f-2') })
    const unrelated = worktree({ worktreeId: 'unrelated' })

    const rows = [folder, web, api, apiChild, archived, other, unrelated]
    expect(getFolderAttachedWorktrees(rows, folder).map((row) => row.worktreeId)).toEqual([
      'api',
      'web',
      'api-child'
    ])
  })
})

describe('findFolderWorkspaceRow', () => {
  it("finds the paired desktop's folder, or a relayed server's when the route names it", () => {
    const serverFolder = { ...folder, hostId: 'runtime:env-1' as const }
    const rows = [serverFolder, folder]
    expect(findFolderWorkspaceRow(rows, 'folder:f-1', undefined)).toBe(folder)
    expect(findFolderWorkspaceRow(rows, 'folder:f-1', 'runtime:env-1')).toBe(serverFolder)
  })
})
