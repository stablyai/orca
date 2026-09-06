import { describe, expect, it } from 'vitest'
import { buildRuntimeWorktreePsSummaries } from './runtime-worktree-ps-summaries'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { RuntimeStore } from './runtime-store-contract'

describe('buildRuntimeWorktreePsSummaries', () => {
  it('preserves persisted host ownership over the resolved row fallback', () => {
    const worktree = {
      id: 'repo-1::/workspace/app',
      repoId: 'repo-1',
      hostId: 'ssh:resolved-host',
      path: '/workspace/app',
      branch: 'feature',
      isArchived: false,
      isMainWorktree: false,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      lastActivityAt: 0
    } as unknown as ResolvedWorktree
    const store = {
      getRepos: () => [],
      getWorktreeMeta: () => ({ hostId: 'ssh:persisted-host' }),
      getAllWorktreeMeta: () => ({}),
      getFolderWorkspaces: () => [],
      getProjectGroups: () => []
    } as unknown as RuntimeStore

    const summary = buildRuntimeWorktreePsSummaries({
      store,
      resolvedWorktrees: [worktree],
      platformByRepoId: new Map()
    }).get(worktree.id)

    expect(summary?.hostId).toBe('ssh:persisted-host')
  })

  it('stamps folder-workspace host ownership from the resolved worktree row', () => {
    const folderWorkspace = {
      id: 'folder-ssh',
      projectGroupId: 'group-1',
      name: 'SSH folder',
      folderPath: '/remote/folder',
      connectionId: 'box-2',
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
    const store = {
      getRepos: () => [],
      getWorktreeMeta: () => undefined,
      getAllWorktreeMeta: () => ({}),
      getFolderWorkspaces: () => [folderWorkspace],
      getProjectGroups: () => [{ id: 'group-1', name: 'Group', parentPath: '/remote' }]
    } as unknown as RuntimeStore

    const summary = [
      ...buildRuntimeWorktreePsSummaries({
        store,
        resolvedWorktrees: [],
        platformByRepoId: new Map()
      }).values()
    ][0]

    expect(summary?.hostId).toBe('ssh:box-2')
  })
})
