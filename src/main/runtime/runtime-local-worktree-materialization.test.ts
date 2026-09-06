import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createWorktreeCopiedPaths: vi.fn(),
  createWorktreeLinkedPaths: vi.fn(),
  createWorktreeSharedPaths: vi.fn(),
  resolveWorktreeIncludePaths: vi.fn(async () => []),
  resolveWorktreeSharedDirectories: vi.fn(async () => [])
}))

vi.mock('../ipc/worktree-symlinks', () => ({
  createWorktreeCopiedPaths: mocks.createWorktreeCopiedPaths,
  createWorktreeLinkedPaths: mocks.createWorktreeLinkedPaths,
  createWorktreeSharedPaths: mocks.createWorktreeSharedPaths
}))
vi.mock('../git/worktree-include-file', () => ({
  resolveWorktreeIncludePaths: mocks.resolveWorktreeIncludePaths
}))
vi.mock('../git/worktree-shared-directories', () => ({
  resolveWorktreeSharedDirectories: mocks.resolveWorktreeSharedDirectories
}))

import { materializeRuntimeLocalWorktree } from './runtime-local-worktree-materialization'

describe('materializeRuntimeLocalWorktree', () => {
  it('records lineage immediately after metadata and before filesystem setup', async () => {
    const order: string[] = []
    mocks.createWorktreeLinkedPaths.mockImplementationOnce(async () => {
      order.push('filesystem')
      throw new Error('link failed')
    })
    const store = {
      getProjectHostSetups: () => [],
      setWorktreeMeta: vi.fn((_id, updates) => ({ ...updates, hostId: 'local' }))
    }

    await expect(
      materializeRuntimeLocalWorktree({
        request: {},
        repo: {
          id: 'repo-1',
          path: '/repo',
          displayName: 'Repo',
          badgeColor: '#000000',
          addedAt: 1,
          symlinkPaths: ['node_modules']
        },
        store,
        settings: { workspaceDir: '/worktrees', nestWorkspaces: true },
        created: {
          path: '/worktrees/app',
          head: 'abc123',
          branch: 'feature/app',
          isBare: false,
          isMainWorktree: false
        },
        remoteTrackingBase: null,
        sparseDirectories: [],
        checkoutExistingBranch: false,
        baseBranch: 'main',
        branchName: 'feature/app',
        effectiveRequestedName: 'app',
        effectiveSanitizedName: 'app',
        localWorktreeGitOptions: {},
        onMetadataPersisted: () => {
          order.push('metadata')
          return null
        }
      } as never)
    ).rejects.toThrow('link failed')

    expect(order).toEqual(['metadata', 'filesystem'])
  })
})
