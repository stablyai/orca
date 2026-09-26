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
  getSshGitProviderMock,
  resetFilesystemIpcMocks
} from './filesystem-test-harness'

const linkedLookup = vi.hoisted(() => ({ run: (): Promise<null> => Promise.resolve(null) }))

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
vi.mock('../source-control/pull-request-linked-issue', async () => {
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
import { invalidateAuthorizedRootsCache } from './registered-worktree-roots-cache'

describe.each(['local', 'SSH'])('PR linked-issue lifetime on %s', (host) => {
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
    worktreePath: host === 'SSH' ? '/remote/repo' : WORKTREE_FEATURE_PATH,
    ...(host === 'SSH' ? { connectionId: 'conn-1' } : {})
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
    getSshGitProviderMock.mockReturnValue({
      exec: vi.fn(),
      executeCommitMessagePlan: vi.fn()
    })
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
        ).resolves.toEqual({
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

  it('still rejects the caller when preparation succeeds but the lookup fails', async () => {
    const issue = Promise.withResolvers<null>()
    const failure = new Error('lookup failed')
    linkedLookup.run = () => issue.promise
    const result = Promise.resolve(
      handlers.get('git:generatePullRequestFields')!(null, request)
    ).catch((error: unknown) => error)
    await nextTurn()
    issue.reject(failure)
    expect(await result).toBe(failure)
    expect(generatePullRequestFieldsFromContextMock).not.toHaveBeenCalled()
  })
})
