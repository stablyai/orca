import { describe, expect, it } from 'vitest'
import { store } from './orca-runtime-test-fixtures.spec'
import { RuntimeWorktreeLineageController } from './runtime-worktree-lineage-controller'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { ExecutionHostId } from '../../shared/execution-host'

function worktree(id: string, hostId?: ExecutionHostId): ResolvedWorktree {
  return {
    id,
    repoId: id,
    instanceId: `${id}-instance`,
    hostId,
    path: `/work/${id}`,
    head: 'abc',
    branch: 'refs/heads/test',
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
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git: {
      path: `/work/${id}`,
      head: 'abc',
      branch: 'refs/heads/test',
      isBare: false,
      isMainWorktree: false
    }
  }
}

describe('persistent lineage host validation', () => {
  it.each(['local', 'ssh:builder', undefined] as const)(
    'derives a legacy child owner from its repository: %s',
    (childHost) => {
      const child = worktree('child')
      const parent = worktree('parent', 'ssh:builder')
      const controller = new RuntimeWorktreeLineageController({
        getStore: () => ({
          ...store,
          getRepos: () =>
            childHost
              ? [
                  {
                    id: 'child',
                    path: '/repo',
                    displayName: 'Child',
                    badgeColor: '',
                    addedAt: 1,
                    executionHostId: childHost
                  }
                ]
              : []
        }),
        getCachedWorktrees: () => [child, parent],
        getDb: () => null,
        resolveWorktree: async () => parent,
        listResolvedWorktrees: async () => [child, parent],
        showTerminal: async () => ({ worktreeId: parent.id })
      })
      if (childHost === 'ssh:builder') {
        expect(() => controller.validateParent(child, parent)).not.toThrow()
      } else {
        expect(() => controller.validateParent(child, parent)).toThrow('same execution host')
      }
    }
  )
})
