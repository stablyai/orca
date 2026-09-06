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
  getSshGitProviderMock,
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
  '../local-downloaded-folder-promotion',
  async () => (await import('./filesystem-test-harness')).folderPromotionMock
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
  '../providers/ssh-filesystem-dispatch',
  async () => (await import('./filesystem-test-harness')).sshFilesystemDispatchMock
)
vi.mock(
  '../providers/ssh-git-dispatch',
  async () => (await import('./filesystem-test-harness')).sshGitDispatchMock
)
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
    // Reset module-level auth cache so each test starts with a fresh dirty
    // flag — prevents stale worktree data from a prior test's cache rebuild.
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
    // Linked worktrees can live anywhere on disk (e.g. ~/.codex/worktrees/).
    // As long as the path matches a worktree reported by `git worktree list`
    // for a registered repo, it should be allowed — the security boundary is
    // worktree registration, not directory containment.
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
    // Reproduces the bug where CLI-created worktrees fail with
    // "Access denied: unknown repository or worktree path" because the
    // filesystem-auth cache was not invalidated after creation.
    const cliWorktreePath = path.resolve('/external/cli-created-worktree')

    // Step 1: register handlers and trigger initial cache build with only
    // the original worktree in the listing.
    registerFilesystemHandlers(store as never)

    // Warm the cache by calling a git operation on the existing worktree.
    getStatusMock.mockResolvedValue({ entries: [] })
    await handlers.get('git:status')!(null, { worktreePath: WORKTREE_FEATURE_PATH })

    // Step 2: simulate the CLI creating a new worktree — git now lists it,
    // but the auth cache is stale.
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

    // Step 3: branchCompare on the new worktree should fail — this is the
    // exact error the user reported.
    await expect(
      handlers.get('git:branchCompare')!(null, {
        worktreePath: cliWorktreePath,
        baseRef: 'origin/main'
      })
    ).rejects.toThrow('Access denied: unknown repository or worktree path')

    // Step 4: invalidate the cache (what our fix does after CLI create).
    invalidateAuthorizedRootsCache()

    // Step 5: the same branchCompare should now succeed.
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

    // Why: validateGitRelativeFilePath uses path.relative() which produces
    // platform-specific separators (backslashes on Windows).
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

  it('forwards the pinned head through SSH branch diff queries', async () => {
    const result = {
      kind: 'text',
      originalContent: 'left',
      modifiedContent: 'right',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
    const getBranchDiff = vi.fn().mockResolvedValue([result])
    getSshGitProviderMock.mockReturnValue({ getBranchDiff })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:branchDiff')!(null, {
        worktreePath: '/home/user/project',
        compare: {
          baseRef: 'origin/main',
          baseOid: 'base-oid',
          headOid: 'head-oid',
          mergeBase: 'merge-base-oid'
        },
        filePath: 'src/file.ts',
        oldPath: 'src/old-file.ts',
        connectionId: 'conn-1'
      })
    ).resolves.toEqual(result)

    expect(getBranchDiff).toHaveBeenCalledWith('/home/user/project', 'merge-base-oid', {
      includePatch: true,
      headOid: 'head-oid',
      filePath: 'src/file.ts',
      oldPath: 'src/old-file.ts'
    })
  })
})
