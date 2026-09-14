import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handlers,
  store,
  WORKTREE_FEATURE_PATH,
  commitChangesMock,
  bulkDiscardChangesMock,
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

  it('routes local git:commit through commitChanges and returns success', async () => {
    commitChangesMock.mockResolvedValue({ success: true })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:commit')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        message: 'feat: ship commit'
      })
    ).resolves.toEqual({ success: true })

    expect(commitChangesMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, 'feat: ship commit', {
      admissionTier: 'interactive'
    })
  })

  it('returns local commit hook failure payload from git:commit', async () => {
    commitChangesMock.mockResolvedValue({ success: false, error: 'hook failed' })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:commit')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        message: 'feat: ship commit'
      })
    ).resolves.toEqual({ success: false, error: 'hook failed' })
  })

  it('routes ssh git:commit through the SSH provider instead of local commitChanges', async () => {
    const sshCommitMock = vi.fn().mockResolvedValue({ success: true })
    getSshGitProviderMock.mockReturnValue({ commit: sshCommitMock })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:commit')!(null, {
        worktreePath: '/remote/repo',
        message: 'feat: remote commit',
        connectionId: 'conn-1'
      })
    ).resolves.toEqual({ success: true })

    expect(sshCommitMock).toHaveBeenCalledWith('/remote/repo', 'feat: remote commit')
    expect(commitChangesMock).not.toHaveBeenCalled()
  })

  it('routes ssh git:remoteCommitUrl through the SSH provider', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567'
    const sshRemoteCommitUrlMock = vi.fn().mockResolvedValue('https://github.com/org/repo/commit/x')
    getSshGitProviderMock.mockReturnValue({ getRemoteCommitUrl: sshRemoteCommitUrlMock })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:remoteCommitUrl')!(null, {
        worktreePath: '/remote/repo',
        sha,
        connectionId: 'conn-1'
      })
    ).resolves.toBe('https://github.com/org/repo/commit/x')

    expect(sshRemoteCommitUrlMock).toHaveBeenCalledWith('/remote/repo', sha)
  })

  it('rejects git:remoteCommitUrl with a short hash before SSH dispatch', async () => {
    const sshRemoteCommitUrlMock = vi.fn()
    getSshGitProviderMock.mockReturnValue({ getRemoteCommitUrl: sshRemoteCommitUrlMock })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:remoteCommitUrl')!(null, {
        worktreePath: '/remote/repo',
        sha: 'abc123',
        connectionId: 'conn-1'
      })
    ).rejects.toThrow('sha must be a full git object id')

    expect(sshRemoteCommitUrlMock).not.toHaveBeenCalled()
  })

  it('routes ssh git:bulkDiscard through the SSH provider', async () => {
    const sshBulkDiscardMock = vi.fn().mockResolvedValue(undefined)
    getSshGitProviderMock.mockReturnValue({ bulkDiscardChanges: sshBulkDiscardMock })

    registerFilesystemHandlers(store as never)

    await handlers.get('git:bulkDiscard')!(null, {
      worktreePath: '/remote/repo',
      filePaths: ['a.ts', 'b.ts'],
      connectionId: 'conn-1'
    })

    expect(sshBulkDiscardMock).toHaveBeenCalledWith('/remote/repo', ['a.ts', 'b.ts'])
    expect(bulkDiscardChangesMock).not.toHaveBeenCalled()
  })

  it('routes ssh git:fastForward through the SSH provider', async () => {
    const sshFastForwardMock = vi.fn().mockResolvedValue(undefined)
    const pushTarget = { remoteName: 'fork', branchName: 'feature/fix' }
    getSshGitProviderMock.mockReturnValue({ fastForwardBranch: sshFastForwardMock })

    registerFilesystemHandlers(store as never)

    await handlers.get('git:fastForward')!(null, {
      worktreePath: '/remote/repo',
      connectionId: 'conn-1',
      pushTarget
    })

    expect(sshFastForwardMock).toHaveBeenCalledWith('/remote/repo', pushTarget)
  })

  it('rejects git:commit with empty message and does not call commitChanges', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:commit')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        message: ''
      })
    ).rejects.toThrow('Commit message is required')

    expect(commitChangesMock).not.toHaveBeenCalled()
  })

  it('rejects git:commit with whitespace-only message and does not call commitChanges', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:commit')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        message: '   '
      })
    ).rejects.toThrow('Commit message is required')

    expect(commitChangesMock).not.toHaveBeenCalled()
  })

  it('rejects git:commit with whitespace-only message before SSH dispatch', async () => {
    const sshCommitMock = vi.fn().mockResolvedValue({ success: true })
    getSshGitProviderMock.mockReturnValue({ commit: sshCommitMock })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:commit')!(null, {
        worktreePath: '/remote/repo',
        message: '\n',
        connectionId: 'conn-1'
      })
    ).rejects.toThrow('Commit message is required')

    expect(sshCommitMock).not.toHaveBeenCalled()
  })
})
