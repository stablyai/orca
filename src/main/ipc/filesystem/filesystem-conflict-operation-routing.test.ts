import type * as WorktreeScanCacheModule from '../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../git/worktrees/catalog/worktree-listing'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handlers,
  store,
  REPO_PATH,
  WORKTREE_FEATURE_PATH,
  detectConflictOperationMock,
  resetFilesystemIpcMocks
} from './filesystem-test-harness'

const getLocalGitOptionsForRegisteredWorktreeMock = vi.hoisted(() => vi.fn())

vi.mock('../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const { listWorktreesMock } = await import('./filesystem-test-harness')
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktreeGraph: listWorktreesMock,
    listWorktrees: listWorktreesMock
  }
})

vi.mock('../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const { listWorktreesMock } = await import('./filesystem-test-harness')
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: listWorktreesMock
  }
})

vi.mock('electron', async () => (await import('./filesystem-test-harness')).electronMock)
vi.mock('fs/promises', async () => (await import('./filesystem-test-harness')).fsPromisesMock)
vi.mock(
  '../../wsl/filesystem/wsl-unc-delete',
  async () => (await import('./filesystem-test-harness')).wslUncDeleteMock
)
vi.mock(
  '../../crash-reporting/crash-breadcrumb-store',
  async () => (await import('./filesystem-test-harness')).crashBreadcrumbMock
)
vi.mock('../../git/source-control/commit-changes', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  commitChanges: (await import('./filesystem-test-harness')).commitChangesMock
}))

vi.mock('../../git/source-control/status-read', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getStatus: (await import('./filesystem-test-harness')).getStatusMock
}))

vi.mock('../../git/source-control/git-conflict-operation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  detectConflictOperation: (await import('./filesystem-test-harness')).detectConflictOperationMock,
  abortMerge: (await import('./filesystem-test-harness')).abortMergeMock,
  abortRebase: (await import('./filesystem-test-harness')).abortRebaseMock
}))

vi.mock('../../git/source-control/file-diff', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDiff: (await import('./filesystem-test-harness')).getDiffMock
}))

vi.mock('../../git/source-control/branch-compare', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBranchCompare: (await import('./filesystem-test-harness')).getBranchCompareMock
}))

vi.mock('../../git/source-control/branch-diff', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBranchDiff: (await import('./filesystem-test-harness')).getBranchDiffMock
}))

vi.mock('../../git/source-control/staged-commit-context', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getStagedCommitContext: (await import('./filesystem-test-harness')).getStagedCommitContextMock
}))

vi.mock('../../git/source-control/staging', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stageFile: (await import('./filesystem-test-harness')).stageFileMock,
  bulkStageFiles: (await import('./filesystem-test-harness')).bulkStageFilesMock,
  stageWorktreeChanges: (await import('./filesystem-test-harness')).stageWorktreeChangesMock,
  unstageFile: (await import('./filesystem-test-harness')).unstageFileMock,
  bulkUnstageFiles: (await import('./filesystem-test-harness')).bulkUnstageFilesMock
}))

vi.mock('../../git/source-control/discard-changes', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  bulkDiscardChanges: (await import('./filesystem-test-harness')).bulkDiscardChangesMock,
  discardChanges: (await import('./filesystem-test-harness')).discardChangesMock
}))
vi.mock(
  '../../git/source-control/check-ignored-paths',
  async () => (await import('./filesystem-test-harness')).gitIgnoredPathsMock
)

vi.mock('../local-worktree-runtime-options', () => ({
  getLocalGitOptionsForRegisteredWorktree: getLocalGitOptionsForRegisteredWorktreeMock,
  getLocalGitOptionsForRepo: vi.fn(() => ({})),
  getLocalRepoForRegisteredWorktree: vi.fn(() => undefined)
}))

import { registerFilesystemHandlers } from './filesystem'
import {
  registerWorktreeRootsForRepo,
  invalidateAuthorizedRootsCache
} from '../worktrees/removal/registered-worktree-roots-cache'

// Read .git in the worktree's own host namespace, including WSL.
describe('git:conflictOperation local routing', () => {
  beforeEach(() => {
    resetFilesystemIpcMocks()
    invalidateAuthorizedRootsCache()
    getLocalGitOptionsForRegisteredWorktreeMock.mockReset()
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({ wslDistro: 'Ubuntu' })
    detectConflictOperationMock.mockResolvedValue('merge')
  })

  it("probes with the registered worktree's local git options", async () => {
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:conflictOperation')!(null, { worktreePath: WORKTREE_FEATURE_PATH })
    ).resolves.toBe('merge')

    expect(getLocalGitOptionsForRegisteredWorktreeMock).toHaveBeenCalledWith(
      store,
      WORKTREE_FEATURE_PATH,
      WORKTREE_FEATURE_PATH
    )
    expect(detectConflictOperationMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, {
      wslDistro: 'Ubuntu'
    })
  })
})

describe('git:conflictOperation ssh routing', () => {
  beforeEach(() => {
    resetFilesystemIpcMocks()
    detectConflictOperationMock.mockReset()
  })

  it('reports an SSH host as not served instead of falling back to this machine', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:conflictOperation')!(null, {
        worktreePath: '/remote/wt',
        connectionId: 'ssh-1'
      })
    ).rejects.toThrow('Remote connection dropped')
    expect(detectConflictOperationMock).not.toHaveBeenCalled()
  })
})
