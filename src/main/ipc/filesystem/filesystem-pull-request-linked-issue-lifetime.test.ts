import type * as WorktreeScanCacheModule from '../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../git/worktrees/catalog/worktree-listing'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handlers,
  store,
  WORKTREE_FEATURE_PATH,
  resolveCommitMessageSettingsMock,
  generatePullRequestFieldsFromContextMock,
  getPullRequestDraftContextMock,
  resolveHostedReviewBodyForGenerationMock,
  loadPullRequestLinkedIssueMock,
  resetFilesystemIpcMocks
} from './filesystem-test-harness'

const linkedLookup = vi.hoisted(() => ({ run: (): Promise<null> => Promise.resolve(null) }))

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

vi.mock(
  '../../text-generation/commit-message-text-generation',
  async () => (await import('./filesystem-test-harness')).textGenerationModuleMock
)
vi.mock(
  '../../text-generation/pull-request-context',
  async () => (await import('./filesystem-test-harness')).pullRequestContextMock
)
vi.mock(
  '../../source-control/pull-request-template',
  async () => (await import('./filesystem-test-harness')).pullRequestTemplateMock
)
vi.mock('../../source-control/pull-request-linked-issue', async () => {
  const { loadPullRequestLinkedIssueMock } = await import('./filesystem-test-harness')
  return {
    loadPullRequestLinkedIssue: (...args: unknown[]) => {
      loadPullRequestLinkedIssueMock(...args)
      // A vi.fn return observer would itself handle the rejection under test.
      return linkedLookup.run()
    }
  }
})

import { registerFilesystemHandlers } from './filesystem'
import { invalidateAuthorizedRootsCache } from '../worktrees/removal/registered-worktree-roots-cache'

describe('PR linked-issue lifetime on a local worktree', () => {
  const draftContext = {
    base: 'main',
    branch: 'feature/ai',
    branchChangedByPreparation: false,
    commitSummary: 'a1b2c3d Add generation',
    changeSummary: 'README.md | 2 +-',
    patch: '+hello',
    currentTitle: '',
    currentBody: '',
    currentDraft: false
  }
  const request = {
    base: 'main',
    title: '',
    body: '',
    draft: false,
    worktreePath: WORKTREE_FEATURE_PATH
  }

  beforeEach(() => {
    resetFilesystemIpcMocks()
    linkedLookup.run = () => Promise.resolve(null)
    invalidateAuthorizedRootsCache()
    resolveCommitMessageSettingsMock.mockReturnValue({
      ok: true,
      params: { agentId: 'codex', model: 'gpt-5.4-mini' }
    })
    resolveHostedReviewBodyForGenerationMock.mockResolvedValue('')
    getPullRequestDraftContextMock.mockResolvedValue(draftContext)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The existing IPC harness provides every Store member reached by this handler.
    registerFilesystemHandlers(store as never)
  })

  it.each(['no changes', 'context error', 'template error'])(
    'observes a late lookup rejection after %s',
    async (outcome) => {
      const issue = Promise.withResolvers<null>()
      linkedLookup.run = () => issue.promise
      const preparationError = new Error('branch preparation failed')
      if (outcome === 'no changes') {
        getPullRequestDraftContextMock.mockResolvedValue(null)
      } else if (outcome === 'context error') {
        getPullRequestDraftContextMock.mockRejectedValue(preparationError)
      } else {
        resolveHostedReviewBodyForGenerationMock.mockRejectedValue(preparationError)
      }
      const unhandled = vi.fn()
      process.on('unhandledRejection', unhandled)
      try {
        await expect(
          handlers.get('git:generatePullRequestFields')!(null, request)
        ).resolves.toMatchObject({
          success: false,
          error:
            outcome === 'no changes' ? 'No branch changes to summarize.' : preparationError.message
        })
        expect(loadPullRequestLinkedIssueMock).toHaveBeenCalledTimes(1)
        issue.reject(new Error('Timed out waiting for a GitLab operation slot.'))
        await nextTurn()
        expect(unhandled).not.toHaveBeenCalled()
        expect(generatePullRequestFieldsFromContextMock).not.toHaveBeenCalled()
      } finally {
        void issue.promise.catch(() => undefined)
        process.off('unhandledRejection', unhandled)
      }
    }
  )

  it('observes a lookup rejection while preparation is pending and preserves the later error', async () => {
    const issue = Promise.withResolvers<null>()
    const preparation = Promise.withResolvers<typeof draftContext>()
    const failure = new Error('lookup admission failed')
    linkedLookup.run = () => issue.promise
    getPullRequestDraftContextMock.mockReturnValue(preparation.promise)
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const result = Promise.resolve(
      handlers.get('git:generatePullRequestFields')!(null, request)
    ).catch((error: unknown) => error)
    try {
      await nextTurn()
      expect(getPullRequestDraftContextMock).toHaveBeenCalledTimes(1)
      issue.reject(failure)
      await nextTurn()
      expect(unhandled).not.toHaveBeenCalled()
      preparation.resolve(draftContext)
      expect(await result).toBe(failure)
      expect(generatePullRequestFieldsFromContextMock).not.toHaveBeenCalled()
    } finally {
      issue.resolve(null)
      preparation.resolve(draftContext)
      await result
      process.off('unhandledRejection', unhandled)
    }
  })
})
