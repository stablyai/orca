import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handlers,
  store,
  WORKTREE_FEATURE_PATH,
  getStatusMock,
  readFileMock,
  statMock,
  openMock,
  resetFilesystemIpcMocks
} from '../testing/filesystem-test-harness'

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const { listWorktreesMock } = await import('../testing/filesystem-test-harness')
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktreeGraph: listWorktreesMock,
    listWorktrees: listWorktreesMock
  }
})

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const { listWorktreesMock } = await import('../testing/filesystem-test-harness')
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: listWorktreesMock
  }
})

vi.mock('electron', async () => (await import('../testing/filesystem-test-harness')).electronMock)
vi.mock(
  'fs/promises',
  async () => (await import('../testing/filesystem-test-harness')).fsPromisesMock
)
vi.mock(
  '../../../wsl/filesystem/wsl-unc-delete',
  async () => (await import('../testing/filesystem-test-harness')).wslUncDeleteMock
)
vi.mock(
  '../../../crash-reporting/breadcrumbs/crash-breadcrumb-store',
  async () => (await import('../testing/filesystem-test-harness')).crashBreadcrumbMock
)
vi.mock('../../../git/source-control/mutations/commit-changes', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  commitChanges: (await import('../testing/filesystem-test-harness')).commitChangesMock
}))

vi.mock('../../../git/source-control/status/status-read', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getStatus: (await import('../testing/filesystem-test-harness')).getStatusMock
}))

vi.mock('../../../git/source-control/mutations/git-conflict-operation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  detectConflictOperation: (await import('../testing/filesystem-test-harness'))
    .detectConflictOperationMock,
  abortMerge: (await import('../testing/filesystem-test-harness')).abortMergeMock,
  abortRebase: (await import('../testing/filesystem-test-harness')).abortRebaseMock
}))

vi.mock('../../../git/source-control/diffs/file-diff', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDiff: (await import('../testing/filesystem-test-harness')).getDiffMock
}))

vi.mock('../../../git/source-control/comparisons/branch-compare', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBranchCompare: (await import('../testing/filesystem-test-harness')).getBranchCompareMock
}))

vi.mock('../../../git/source-control/comparisons/branch-diff', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBranchDiff: (await import('../testing/filesystem-test-harness')).getBranchDiffMock
}))

vi.mock('../../../git/source-control/mutations/staged-commit-context', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getStagedCommitContext: (await import('../testing/filesystem-test-harness'))
    .getStagedCommitContextMock
}))

vi.mock('../../../git/source-control/mutations/staging', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stageFile: (await import('../testing/filesystem-test-harness')).stageFileMock,
  bulkStageFiles: (await import('../testing/filesystem-test-harness')).bulkStageFilesMock,
  stageWorktreeChanges: (await import('../testing/filesystem-test-harness'))
    .stageWorktreeChangesMock,
  unstageFile: (await import('../testing/filesystem-test-harness')).unstageFileMock,
  bulkUnstageFiles: (await import('../testing/filesystem-test-harness')).bulkUnstageFilesMock
}))

vi.mock('../../../git/source-control/mutations/discard-changes', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  bulkDiscardChanges: (await import('../testing/filesystem-test-harness')).bulkDiscardChangesMock,
  discardChanges: (await import('../testing/filesystem-test-harness')).discardChangesMock
}))
vi.mock(
  '../../../git/source-control/ignores/check-ignored-paths',
  async () => (await import('../testing/filesystem-test-harness')).gitIgnoredPathsMock
)

vi.mock(
  '../../../text-generation/commit-message-text-generation',
  async () => (await import('../testing/filesystem-test-harness')).textGenerationModuleMock
)
vi.mock(
  '../../../text-generation/pull-request-context/pull-request-context',
  async () => (await import('../testing/filesystem-test-harness')).pullRequestContextMock
)
vi.mock(
  '../../../source-control/pull-request-template',
  async () => (await import('../testing/filesystem-test-harness')).pullRequestTemplateMock
)
vi.mock(
  '../../../source-control/pull-request-linked-issue',
  async () => (await import('../testing/filesystem-test-harness')).pullRequestLinkedIssueMock
)

import { registerFilesystemHandlers } from '../filesystem'
import { SshHostNotServedError } from '../../../providers/ssh-host-not-served-error'
import { invalidateAuthorizedRootsCache } from '../../worktrees/removal/registered-worktree-roots-cache'

describe('registerFilesystemHandlers', () => {
  beforeEach(() => {
    resetFilesystemIpcMocks()
    // Drop cached roots between fixtures.
    invalidateAuthorizedRootsCache()
  })

  it('rejects direct SSH status and reads before any local access', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the existing fixture supplies the store API exercised by these handlers.
    registerFilesystemHandlers(store as never)
    await expect(
      handlers.get('git:status')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        connectionId: 'ssh-unserved'
      })
    ).rejects.toThrow(SshHostNotServedError)
    await expect(
      handlers.get('fs:readFile')!(null, {
        filePath: `${WORKTREE_FEATURE_PATH}/a.ts`,
        connectionId: 'ssh-unserved'
      })
    ).rejects.toThrow(SshHostNotServedError)
    expect(getStatusMock).not.toHaveBeenCalled()
    expect(readFileMock).not.toHaveBeenCalled()
    expect(statMock).not.toHaveBeenCalled()
    expect(openMock).not.toHaveBeenCalled()
  })
})
