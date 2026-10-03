import { describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../shared/folder-workspace-types'
import type { Repo } from '../shared/repo-types'
import { loadKnownUsageWorktreesByRepo } from './usage-worktree-metadata'

describe('loadKnownUsageWorktreesByRepo', () => {
  it('builds usage worktree refs from repo roots and persisted metadata', () => {
    const store = {
      getAllWorktreeMeta: vi.fn(() => ({
        'repo-1::/workspace/repo-a-feature': {
          displayName: 'Feature A'
        },
        'repo-2::/remote/repo-b-feature': {
          displayName: 'Remote feature'
        },
        malformed: {
          displayName: 'Ignored'
        }
      }))
    }
    const repos = [
      {
        id: 'repo-1',
        path: '/workspace/repo-a',
        displayName: 'Repo A'
      },
      {
        id: 'repo-2',
        path: '/remote/repo-b',
        displayName: 'Remote Repo',
        connectionId: 'ssh-1'
      }
    ]

    expect(loadKnownUsageWorktreesByRepo(store as never, repos as never)).toEqual(
      new Map([
        [
          'repo-1',
          [
            {
              worktreeId: 'repo-1::/workspace/repo-a',
              path: '/workspace/repo-a',
              displayName: 'Repo A'
            },
            {
              worktreeId: 'repo-1::/workspace/repo-a-feature',
              path: '/workspace/repo-a-feature',
              displayName: 'Feature A'
            }
          ]
        ]
      ])
    )
    expect(store.getAllWorktreeMeta).toHaveBeenCalledTimes(1)
  })

  it('indexes local folder workspaces so their sessions can be attributed', () => {
    const localFolderWorkspace: FolderWorkspace = {
      id: 'workspace-1',
      projectGroupId: 'group-1',
      name: 'Plain Folder',
      folderPath: '/outside/plain-folder',
      connectionId: null,
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0
    }
    const remoteFolderWorkspace: FolderWorkspace = {
      ...localFolderWorkspace,
      id: 'workspace-2',
      name: 'Remote Folder',
      folderPath: '/remote/plain-folder',
      connectionId: 'ssh-1'
    }
    // A folder workspace does not persist `executionHostId`, so its remote scope arrives through
    // `connectionId` or through an in-scope repo that names its SSH host only that way.
    const sshStampedFolderWorkspace: FolderWorkspace = {
      ...localFolderWorkspace,
      id: 'workspace-3',
      projectGroupId: 'group-3',
      name: 'SSH Stamped Folder',
      folderPath: '/ssh-stamped/plain-folder',
      connectionId: null
    }
    const sshStampedRepo: Repo = {
      id: 'repo-ssh',
      path: '/ssh-stamped/plain-folder/sub',
      displayName: 'SSH Repo',
      badgeColor: '',
      addedAt: 0,
      executionHostId: 'ssh:target-1'
    }
    const store = {
      getAllWorktreeMeta: () => ({}),
      getFolderWorkspaces: () => [
        localFolderWorkspace,
        remoteFolderWorkspace,
        sshStampedFolderWorkspace
      ]
    }

    const refs = loadKnownUsageWorktreesByRepo(store, [sshStampedRepo])

    // Only the plain local workspace is indexed. The `connectionId` pin and the in-scope repo that
    // names its SSH host only through `executionHostId` both classify as remote. Repo-side ownership
    // has its own pre-existing gap and is not what this assertion covers.
    expect(refs.get('folder-workspace:group-1')).toEqual([
      {
        worktreeId: 'folder:workspace-1',
        path: '/outside/plain-folder',
        displayName: 'Plain Folder'
      }
    ])
    expect(refs.get('folder-workspace:group-3')).toBeUndefined()
  })

  it('indexes repos once for many persisted worktrees', () => {
    const repoCount = 200
    let repoIdReads = 0
    const repos = Array.from({ length: repoCount }, (_, index) => ({
      get id() {
        repoIdReads += 1
        return `repo-${index}`
      },
      path: `/workspace/repo-${index}`,
      displayName: `Repo ${index}`
    }))
    const worktreeMeta = Object.fromEntries(
      Array.from({ length: repoCount }, (_, offset) => {
        const index = repoCount - offset - 1
        return [
          `repo-${index}::/workspace/repo-${index}-feature`,
          { displayName: `Feature ${index}` }
        ]
      })
    )

    const result = loadKnownUsageWorktreesByRepo(
      { getAllWorktreeMeta: () => worktreeMeta } as never,
      repos as never
    )

    expect(result.size).toBe(repoCount)
    expect([...result.values()].every((worktrees) => worktrees.length === 2)).toBe(true)
    expect(repoIdReads).toBeLessThanOrEqual(repoCount * 4)
  })
})
