import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handlers,
  store,
  REPO_PATH,
  WORKTREE_FEATURE_PATH,
  getStatusMock,
  getBranchCompareMock,
  getBranchDiffMock,
  listWorktreesMock,
  resetFilesystemIpcMocks
} from './filesystem-test-harness'

vi.mock('electron', async () => (await import('./filesystem-test-harness')).electronMock)
vi.mock('fs/promises', async () => (await import('./filesystem-test-harness')).fsPromisesMock)
vi.mock(
  '../wsl-unc-delete',
  async () => (await import('./filesystem-test-harness')).wslUncDeleteMock
)
vi.mock(
  '../crash-reporting/crash-breadcrumb-store',
  async () => (await import('./filesystem-test-harness')).crashBreadcrumbMock
)
vi.mock(
  '../git/status',
  async () => (await import('./filesystem-test-harness')).gitStatusModuleMock
)
vi.mock(
  '../git/check-ignored-paths',
  async () => (await import('./filesystem-test-harness')).gitIgnoredPathsMock
)
vi.mock('../git/worktree', async () => (await import('./filesystem-test-harness')).gitWorktreeMock)
vi.mock(
  '../text-generation/commit-message-text-generation',
  async () => (await import('./filesystem-test-harness')).textGenerationModuleMock
)
vi.mock(
  '../text-generation/pull-request-context',
  async () => (await import('./filesystem-test-harness')).pullRequestContextMock
)
vi.mock(
  '../source-control/pull-request-template',
  async () => (await import('./filesystem-test-harness')).pullRequestTemplateMock
)
vi.mock(
  '../source-control/pull-request-linked-issue',
  async () => (await import('./filesystem-test-harness')).pullRequestLinkedIssueMock
)

import { registerFilesystemHandlers } from './filesystem'
import { invalidateAuthorizedRootsCache } from './registered-worktree-roots-cache'

describe('registerFilesystemHandlers', () => {
  beforeEach(() => {
    resetFilesystemIpcMocks()
    // Drop cached roots between fixtures.
    invalidateAuthorizedRootsCache()
  })

  it('routes branch compare queries through the git compare helper', async () => {
    getBranchCompareMock.mockResolvedValue({
      summary: {
        baseRef: 'origin/main',
        baseOid: 'base-oid',
        compareRef: 'main',
        headOid: 'head-oid',
        mergeBase: 'merge-base-oid',
        changedFiles: 1,
        status: 'ready'
      },
      entries: [{ path: 'src/file.ts', status: 'modified' }]
    })

    registerFilesystemHandlers(store as never)

    await handlers.get('git:branchCompare')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      baseRef: 'origin/main',
      admissionTier: 'background'
    })

    expect(getBranchCompareMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, 'origin/main', {
      admissionTier: 'background'
    })
  })

  it('allows git operations on worktrees outside repo/workspace roots', async () => {
    // Git-registered worktrees may live outside the repo; registration defines the boundary.
    const externalWorktreePath = path.resolve('/external/worktrees/feature')
    listWorktreesMock.mockResolvedValue([
      {
        path: REPO_PATH,
        head: 'abc',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: externalWorktreePath,
        head: 'def',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: false
      }
    ])

    getBranchCompareMock.mockResolvedValue({
      summary: {
        baseRef: 'origin/main',
        baseOid: 'base-oid',
        compareRef: 'feature',
        headOid: 'head-oid',
        mergeBase: 'merge-base-oid',
        changedFiles: 0,
        status: 'ready'
      },
      entries: []
    })

    registerFilesystemHandlers(store as never)

    await handlers.get('git:branchCompare')!(null, {
      worktreePath: externalWorktreePath,
      baseRef: 'origin/main'
    })

    expect(getBranchCompareMock).toHaveBeenCalledWith(externalWorktreePath, 'origin/main', {})
  })

  it('rejects branchCompare for a worktree added after cache was built, then succeeds after invalidation', async () => {
    const cliWorktreePath = path.resolve('/external/cli-created-worktree')

    registerFilesystemHandlers(store as never)

    // Warm authorization before simulating CLI creation.
    getStatusMock.mockResolvedValue({ entries: [] })
    await handlers.get('git:status')!(null, { worktreePath: WORKTREE_FEATURE_PATH })

    // Git now lists the CLI-created worktree, but authorization still has its old cache.
    listWorktreesMock.mockResolvedValue([
      {
        path: WORKTREE_FEATURE_PATH,
        head: 'abc',
        branch: '',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: cliWorktreePath,
        head: 'def',
        branch: 'refs/heads/cli-feature',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await expect(
      handlers.get('git:branchCompare')!(null, {
        worktreePath: cliWorktreePath,
        baseRef: 'origin/main'
      })
    ).rejects.toThrow('Access denied: unknown repository or worktree path')

    invalidateAuthorizedRootsCache()

    getBranchCompareMock.mockResolvedValue({
      summary: {
        baseRef: 'origin/main',
        baseOid: 'base-oid',
        compareRef: 'cli-feature',
        headOid: 'head-oid',
        mergeBase: 'merge-base-oid',
        changedFiles: 0,
        status: 'ready'
      },
      entries: []
    })

    await handlers.get('git:branchCompare')!(null, {
      worktreePath: cliWorktreePath,
      baseRef: 'origin/main'
    })

    expect(getBranchCompareMock).toHaveBeenCalledWith(cliWorktreePath, 'origin/main', {})
  })

  it('routes branch diff queries through the pinned branch diff helper', async () => {
    getBranchDiffMock.mockResolvedValue({
      kind: 'text',
      originalContent: 'left',
      modifiedContent: 'right',
      originalIsBinary: false,
      modifiedIsBinary: false
    })

    registerFilesystemHandlers(store as never)

    await handlers.get('git:branchDiff')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      compare: {
        baseRef: 'origin/main',
        baseOid: 'base-oid',
        headOid: 'head-oid',
        mergeBase: 'merge-base-oid'
      },
      filePath: 'src/file.ts',
      oldPath: 'src/old-file.ts'
    })

    // Expected Git paths use the host's path.relative separators.
    expect(getBranchDiffMock).toHaveBeenCalledWith(
      WORKTREE_FEATURE_PATH,
      {
        headOid: 'head-oid',
        mergeBase: 'merge-base-oid',
        filePath: path.join('src', 'file.ts'),
        oldPath: path.join('src', 'old-file.ts')
      },
      { admissionTier: 'interactive' }
    )
  })
})
