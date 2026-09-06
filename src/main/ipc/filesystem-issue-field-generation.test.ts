import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handlers,
  store,
  WORKTREE_FEATURE_PATH,
  resolveCommitMessageSettingsMock,
  generateIssueFieldsFromContextMock,
  cancelGenerateIssueFieldsLocalMock,
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

describe('git:generateIssueFields', () => {
  const params = { agentId: 'claude', model: 'claude-sonnet-5' }
  const ISSUE_ARGS = {
    worktreePath: WORKTREE_FEATURE_PATH,
    title: 'Add a Print button',
    body: 'Print the open document.',
    repoSlug: 'owner/repo'
  }
  const SSH_REPO = {
    id: 'repo-ssh',
    path: '/remote/repo',
    displayName: 'remote',
    badgeColor: '#000',
    addedAt: 0,
    connectionId: 'conn-1'
  }
  const sshStore = {
    ...store,
    getRepo: (id: string) => (id === 'repo-ssh' ? SSH_REPO : undefined)
  }

  beforeEach(() => {
    resetFilesystemIpcMocks()
    invalidateAuthorizedRootsCache()
    resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
    generateIssueFieldsFromContextMock.mockResolvedValue({
      success: true,
      fields: { title: 'T', body: 'B', labels: ['bug'] }
    })
  })

  it('resolves the pullRequest settings lane and generates against the local worktree', async () => {
    registerFilesystemHandlers(store as never)

    const result = await handlers.get('git:generateIssueFields')!(null, {
      ...ISSUE_ARGS,
      availableLabels: ['bug', 42, 'story']
    })

    expect(resolveCommitMessageSettingsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'pullRequest',
      null
    )
    expect(generateIssueFieldsFromContextMock).toHaveBeenCalledWith(
      {
        currentTitle: 'Add a Print button',
        currentBody: 'Print the open document.',
        repoSlug: 'owner/repo',
        // Why: renderer input is untrusted — non-string entries must not reach the prompt.
        availableLabels: ['bug', 'story']
      },
      params,
      expect.objectContaining({ kind: 'local', cwd: WORKTREE_FEATURE_PATH })
    )
    expect(result).toEqual({ success: true, fields: { title: 'T', body: 'B', labels: ['bug'] } })
  })

  it('returns the settings error without spawning when resolution fails', async () => {
    resolveCommitMessageSettingsMock.mockReturnValue({ ok: false, error: 'not configured' })
    registerFilesystemHandlers(store as never)

    const result = await handlers.get('git:generateIssueFields')!(null, { ...ISSUE_ARGS })

    expect(result).toEqual({ success: false, error: 'not configured' })
    expect(generateIssueFieldsFromContextMock).not.toHaveBeenCalled()
  })

  it('routes SSH requests for an owned worktree through the git provider as a remote target', async () => {
    const executeCommitMessagePlan = vi.fn()
    getSshGitProviderMock.mockReturnValue({ executeCommitMessagePlan })
    registerFilesystemHandlers(sshStore as never)

    await handlers.get('git:generateIssueFields')!(null, {
      ...ISSUE_ARGS,
      worktreePath: '/remote/repo',
      repoId: 'repo-ssh',
      connectionId: 'conn-1'
    })

    expect(resolveCommitMessageSettingsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'pullRequest',
      SSH_REPO
    )
    expect(generateIssueFieldsFromContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ currentTitle: 'Add a Print button' }),
      params,
      expect.objectContaining({ kind: 'remote', cwd: '/remote/repo' })
    )
  })

  it('rejects an SSH worktree that no registered repo for the connection owns', async () => {
    getSshGitProviderMock.mockReturnValue({ executeCommitMessagePlan: vi.fn() })
    registerFilesystemHandlers(sshStore as never)

    const result = (await handlers.get('git:generateIssueFields')!(null, {
      ...ISSUE_ARGS,
      worktreePath: '/somewhere/else',
      connectionId: 'conn-1'
    })) as { success: boolean; error?: string }

    expect(result.success).toBe(false)
    expect(result.error).toContain('Access denied')
    expect(generateIssueFieldsFromContextMock).not.toHaveBeenCalled()
  })

  it('fails closed when the SSH provider is unavailable', async () => {
    registerFilesystemHandlers(sshStore as never)

    const result = (await handlers.get('git:generateIssueFields')!(null, {
      ...ISSUE_ARGS,
      worktreePath: '/remote/repo',
      repoId: 'repo-ssh',
      connectionId: 'conn-1'
    })) as { success: boolean }

    expect(result.success).toBe(false)
    expect(generateIssueFieldsFromContextMock).not.toHaveBeenCalled()
  })

  it('cancels the local lane through the resolved worktree path', async () => {
    registerFilesystemHandlers(store as never)

    await handlers.get('git:cancelGenerateIssueFields')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH
    })

    expect(cancelGenerateIssueFieldsLocalMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH)
  })

  it('cancels the SSH lane with the issue-fields operation', async () => {
    const cancelGenerateCommitMessage = vi.fn()
    getSshGitProviderMock.mockReturnValue({ cancelGenerateCommitMessage })
    registerFilesystemHandlers(store as never)

    await handlers.get('git:cancelGenerateIssueFields')!(null, {
      worktreePath: '/remote/repo',
      connectionId: 'conn-1'
    })

    expect(cancelGenerateCommitMessage).toHaveBeenCalledWith('/remote/repo', 'issue-fields')
  })
})
