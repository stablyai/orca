import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as gitRunner from '../git/runner'
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

  describe('git:generatePullRequestFields linked issue', () => {
    const PULL_REQUEST_CONTEXT = {
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
    const PULL_REQUEST_ARGS = { base: 'main', title: '', body: '', draft: false }
    const params = { agentId: 'codex', model: 'gpt-5.4-mini' }

    beforeEach(() => {
      resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
      resolveHostedReviewBodyForGenerationMock.mockResolvedValue('')
      getPullRequestDraftContextMock.mockResolvedValue(PULL_REQUEST_CONTEXT)
      generatePullRequestFieldsFromContextMock.mockResolvedValue({ success: true, fields: {} })
    })

    it('enriches the local pull-request context with a validated worktree linked issue', async () => {
      const worktreeId = `repo-1::${WORKTREE_FEATURE_PATH}`
      const linkedIssueDetails = {
        provider: 'github',
        number: 123,
        title: 'Improve PR generation',
        description: 'Include issue context.'
      }
      loadPullRequestLinkedIssueMock.mockResolvedValue(linkedIssueDetails)
      const linkedStore = {
        ...store,
        getWorktreeMeta: (id: string) => (id === worktreeId ? { linkedIssue: 123 } : undefined)
      }

      registerFilesystemHandlers(linkedStore as never)

      await handlers.get('git:generatePullRequestFields')!(null, {
        ...PULL_REQUEST_ARGS,
        worktreePath: WORKTREE_FEATURE_PATH,
        worktreeId,
        provider: 'github'
      })

      expect(generatePullRequestFieldsFromContextMock).toHaveBeenCalledWith(
        {
          ...PULL_REQUEST_CONTEXT,
          linkedIssue: 123,
          provider: 'github',
          linkedIssueDetails
        },
        params,
        expect.objectContaining({ kind: 'local' })
      )
    })

    it('enriches the SSH pull-request context from host meta using the remote path', async () => {
      const worktreeId = 'repo-1::/remote/repo'
      getSshGitProviderMock.mockReturnValue({
        exec: vi.fn(),
        executeCommitMessagePlan: vi.fn()
      })
      const linkedStore = {
        ...store,
        getWorktreeMeta: (id: string) => (id === worktreeId ? { linkedIssue: 77 } : undefined)
      }

      registerFilesystemHandlers(linkedStore as never)

      await handlers.get('git:generatePullRequestFields')!(null, {
        ...PULL_REQUEST_ARGS,
        worktreePath: '/remote/repo',
        worktreeId,
        connectionId: 'conn-1'
      })

      expect(generatePullRequestFieldsFromContextMock).toHaveBeenCalledWith(
        { ...PULL_REQUEST_CONTEXT, linkedIssue: 77 },
        params,
        expect.objectContaining({ kind: 'remote' })
      )
    })

    it('ignores a pull-request worktree id that does not own the requested path', async () => {
      const getWorktreeMeta = vi.fn(() => ({ linkedIssue: 123 }))

      registerFilesystemHandlers({ ...store, getWorktreeMeta } as never)

      await handlers.get('git:generatePullRequestFields')!(null, {
        ...PULL_REQUEST_ARGS,
        worktreePath: WORKTREE_FEATURE_PATH,
        worktreeId: `repo-1::${path.resolve('/workspace/repo-other')}`
      })

      expect(getWorktreeMeta).not.toHaveBeenCalled()
      // Why: without the length guard the property assertion passes vacuously on `undefined`,
      // so an unrelated early return would read as "enrichment correctly suppressed".
      expect(generatePullRequestFieldsFromContextMock.mock.calls).toHaveLength(1)
      expect(generatePullRequestFieldsFromContextMock.mock.calls[0]?.[0]).not.toHaveProperty(
        'linkedIssue'
      )
    })

    it('forwards PR-context command limits through local and SSH adapters', async () => {
      const localGitExec = vi
        .spyOn(gitRunner, 'gitExecFileAsync')
        .mockResolvedValue({ stdout: '', stderr: '' })
      const sshExec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
      getSshGitProviderMock.mockReturnValue({
        exec: sshExec,
        executeCommitMessagePlan: vi.fn()
      })
      getPullRequestDraftContextMock.mockImplementation(async (execute) => {
        await execute(['show-ref', '--verify'], { maxBuffer: 123, timeoutMs: 456 })
        await execute(['legacy-probe'], { timeout: 789 })
        return PULL_REQUEST_CONTEXT
      })

      try {
        registerFilesystemHandlers(store as never)

        await handlers.get('git:generatePullRequestFields')!(null, {
          ...PULL_REQUEST_ARGS,
          worktreePath: WORKTREE_FEATURE_PATH
        })

        expect(localGitExec).toHaveBeenCalledWith(['show-ref', '--verify'], {
          cwd: WORKTREE_FEATURE_PATH,
          maxBuffer: 123,
          timeout: 456
        })
        expect(localGitExec).toHaveBeenCalledWith(['legacy-probe'], {
          cwd: WORKTREE_FEATURE_PATH,
          timeout: 789
        })

        await handlers.get('git:generatePullRequestFields')!(null, {
          ...PULL_REQUEST_ARGS,
          worktreePath: '/remote/repo',
          connectionId: 'conn-1'
        })

        expect(sshExec).toHaveBeenCalledWith(['show-ref', '--verify'], '/remote/repo', {
          timeoutMs: 456
        })
        expect(sshExec).toHaveBeenCalledWith(['legacy-probe'], '/remote/repo', {
          timeoutMs: 789
        })
      } finally {
        localGitExec.mockRestore()
      }
    })
  })
})
