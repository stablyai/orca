import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listWorktreesMock,
  addWorktreeMock,
  getBranchConflictKindMock,
  getPRForBranchMock,
  getHostedReviewForBranchMock,
  computeWorktreePathMock,
  gitExecFileAsyncMock
} from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'
import type { WorktreeRuntimeStub } from './worktrees-test-runtime-stub'

vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../git/worktree', async () =>
  (await import('./worktrees-test-module-mocks')).gitWorktreeModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./worktrees-test-module-mocks')).gitRunnerModuleMock()
)
vi.mock('../git/repo', async () =>
  (await import('./worktrees-test-module-mocks')).gitRepoModuleMock()
)
vi.mock('../git/git-username', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLocalGitUsername: (await import('./worktrees-test-module-mocks'))
    .resolveLocalGitUsernameMock
}))
vi.mock('../github/client', async () =>
  (await import('./worktrees-test-module-mocks')).githubClientModuleMock()
)
vi.mock('../source-control/hosted-review', async () =>
  (await import('./worktrees-test-module-mocks')).hostedReviewModuleMock()
)
vi.mock('../providers/ssh-git-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshGitDispatchModuleMock()
)
vi.mock('../providers/ssh-filesystem-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshFilesystemDispatchModuleMock()
)
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
)
vi.mock('./ssh', async () => (await import('./worktrees-test-module-mocks')).sshModuleMock())
vi.mock('../ssh/ssh-target-registry', async () =>
  (await import('./worktrees-test-module-mocks')).sshTargetRegistryModuleMock()
)
vi.mock('../hooks', async () => (await import('./worktrees-test-module-mocks')).hooksModuleMock())
vi.mock('../setup-runner-script-text', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupRunnerScriptTextModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../setup-hook-env-vars', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupHookEnvVarsModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('./worktree-logic', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../terminal-history-deletion', async () =>
  (await import('./worktrees-test-module-mocks')).terminalHistoryDeletionModuleMock()
)
vi.mock('../ports/advertised-url-watcher', async () =>
  (await import('./worktrees-test-module-mocks')).advertisedUrlWatcherModuleMock()
)
vi.mock('../workspace-cleanup-scan-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupScanSnapshotModuleMock()
)
vi.mock('../workspace-space-analysis-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceSpaceAnalysisSnapshotModuleMock()
)
vi.mock('../workspace-cleanup-removal-snapshot-prune', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupRemovalSnapshotPruneModuleMock()
)
vi.mock('../runtime/worktree-teardown', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeTeardownModuleMock()
)
vi.mock('./pty', async () => (await import('./worktrees-test-module-mocks')).ptyModuleMock())

describe('registerWorktreeHandlers', () => {
  let runtimeStub: WorktreeRuntimeStub

  beforeEach(() => {
    runtimeStub = setupWorktreeHandlers()
  })

  it('checks out a selected existing local branch exactly', async () => {
    listWorktreesMock
      .mockResolvedValueOnce([
        {
          path: '/workspace/repo',
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
      .mockResolvedValueOnce([
        {
          path: '/workspace/repo',
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/workspace/fix-bug-0',
          head: 'abc123',
          branch: 'refs/heads/fix/bug-0',
          isBare: false,
          isMainWorktree: false
        }
      ])

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'fix/bug-0',
      baseBranch: 'fix/bug-0',
      branchNameOverride: 'fix/bug-0'
    })

    expect(getBranchConflictKindMock).not.toHaveBeenCalled()
    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/fix-bug-0',
      'fix/bug-0',
      'fix/bug-0',
      false,
      false,
      { checkoutExistingBranch: true }
    )
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/fix-bug-0',
      expect.objectContaining({ preserveBranchOnDelete: true })
    )
    expect(result).toMatchObject({
      worktree: expect.objectContaining({
        path: '/workspace/fix-bug-0',
        branch: 'refs/heads/fix/bug-0'
      })
    })
  })

  it('reuses an existing local branch when the worktree folder is renamed (#5181)', async () => {
    // Why: reuse keeps branchNameOverride on the selected branch though the folder is renamed; backend must check out that branch (no -b).
    listWorktreesMock
      .mockResolvedValueOnce([
        {
          path: '/workspace/repo',
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
      .mockResolvedValueOnce([
        {
          path: '/workspace/repo',
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/workspace/my-folder',
          head: 'abc123',
          branch: 'refs/heads/fix/bug-0',
          isBare: false,
          isMainWorktree: false
        }
      ])

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'my-folder',
      baseBranch: 'fix/bug-0',
      branchNameOverride: 'fix/bug-0'
    })

    expect(getBranchConflictKindMock).not.toHaveBeenCalled()
    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/my-folder',
      'fix/bug-0',
      'fix/bug-0',
      false,
      false,
      { checkoutExistingBranch: true }
    )
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/my-folder',
      expect.objectContaining({ preserveBranchOnDelete: true })
    )
    expect(result).toMatchObject({
      worktree: expect.objectContaining({
        path: '/workspace/my-folder',
        branch: 'refs/heads/fix/bug-0'
      })
    })
  })

  it('suffixes only the path when an existing local branch checkout path already exists', async () => {
    const mainWorktree = {
      path: '/workspace/repo',
      head: 'main',
      branch: 'refs/heads/main',
      isBare: false,
      isMainWorktree: true
    }
    computeWorktreePathMock.mockImplementation((sanitizedName: string) =>
      sanitizedName === 'fix-bug-0' ? process.cwd() : `/workspace/${sanitizedName}`
    )
    listWorktreesMock
      .mockResolvedValueOnce([mainWorktree])
      .mockResolvedValueOnce([mainWorktree])
      .mockResolvedValueOnce([
        mainWorktree,
        {
          path: '/workspace/fix-bug-0-2',
          head: 'abc123',
          branch: 'refs/heads/fix/bug-0',
          isBare: false,
          isMainWorktree: false
        }
      ])

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'fix/bug-0',
      baseBranch: 'fix/bug-0',
      branchNameOverride: 'fix/bug-0'
    })

    expect(getBranchConflictKindMock).not.toHaveBeenCalled()
    expect(getPRForBranchMock).not.toHaveBeenCalled()
    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/fix-bug-0-2',
      'fix/bug-0',
      'fix/bug-0',
      false,
      false,
      { checkoutExistingBranch: true }
    )
    expect(result).toMatchObject({
      worktree: expect.objectContaining({
        path: '/workspace/fix-bug-0-2',
        branch: 'refs/heads/fix/bug-0'
      })
    })
  })

  it('suffixes branchNameOverride when the requested branch collides', async () => {
    getBranchConflictKindMock.mockImplementation(async (_repoPath: string, branch: string) =>
      branch === 'feature/something' ? 'remote' : null
    )
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/feature-something-2',
        head: 'abc123',
        branch: 'refs/heads/feature/something-2',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'feature/something',
      branchNameOverride: 'feature/something'
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['check-ref-format', '--branch', 'feature/something-2'],
      { cwd: '/workspace/repo' }
    )
    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/feature-something-2',
      'feature/something-2',
      'origin/main',
      false
    )
  })

  it('allows a resolver-provided PR branch override to match its remote push target', async () => {
    getBranchConflictKindMock.mockImplementation(async (_repoPath: string, branch: string) =>
      branch === 'feature/fix' ? 'remote' : null
    )
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/fix-title',
        head: 'abc123',
        branch: 'refs/heads/feature/fix',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)
    getPRForBranchMock.mockResolvedValueOnce({
      number: 42,
      title: 'Selected PR',
      state: 'open',
      url: 'https://example.com/pr/42',
      checksStatus: 'success',
      updatedAt: '2026-05-21T00:00:00Z',
      mergeable: 'UNKNOWN'
    })

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'fix-title',
      baseBranch: 'abc123',
      compareBaseRef: 'refs/remotes/origin/main',
      branchNameOverride: 'feature/fix',
      linkedPR: 42,
      pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
    })

    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/fix-title',
      'feature/fix',
      'abc123',
      false
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['branch', '--set-upstream-to', 'origin/feature/fix', 'feature/fix'],
      { cwd: '/workspace/fix-title' }
    )
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/fix-title',
      expect.objectContaining({
        baseRef: 'refs/remotes/origin/main',
        linkedPR: 42
      })
    )
    expect(getPRForBranchMock).toHaveBeenCalledWith('/workspace/repo', 'feature/fix')
  })

  it('persists an explicit compare base ahead of the checkout remote-tracking base', async () => {
    runtimeStub.resolveRemoteTrackingBase.mockResolvedValueOnce({
      base: 'origin/source-branch',
      remote: 'origin',
      branch: 'source-branch',
      ref: 'refs/remotes/origin/source-branch'
    })
    runtimeStub.hasRemoteTrackingRef.mockResolvedValueOnce(true)
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/fix-title',
        head: 'abc123',
        branch: 'refs/heads/feature/fix',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'fix-title',
      baseBranch: 'origin/source-branch',
      compareBaseRef: 'refs/remotes/origin/main',
      branchNameOverride: 'feature/fix',
      linkedGitLabMR: 7,
      pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
    })

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/fix-title',
      expect.objectContaining({
        baseRef: 'refs/remotes/origin/main',
        linkedGitLabMR: 7
      })
    )
  })

  it('allows a selected Bitbucket PR branch override to match its remote push target', async () => {
    getBranchConflictKindMock.mockImplementation(async (_repoPath: string, branch: string) =>
      branch === 'feature/bitbucket' ? 'remote' : null
    )
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/bitbucket-title',
        head: 'abc123',
        branch: 'refs/heads/feature/bitbucket',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)
    getHostedReviewForBranchMock.mockResolvedValueOnce({
      provider: 'bitbucket',
      number: 11,
      title: 'Bitbucket PR',
      state: 'open',
      url: 'https://bitbucket.org/team/repo/pull-requests/11',
      status: 'success',
      updatedAt: '2026-05-21T00:00:00Z',
      mergeable: 'UNKNOWN'
    })

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'bitbucket-title',
      baseBranch: 'abc123',
      branchNameOverride: 'feature/bitbucket',
      linkedBitbucketPR: 11,
      pushTarget: { remoteName: 'origin', branchName: 'feature/bitbucket' }
    })

    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/bitbucket-title',
      'feature/bitbucket',
      'abc123',
      false
    )
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/bitbucket-title',
      expect.objectContaining({ linkedBitbucketPR: 11 })
    )
    expect(getHostedReviewForBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: '/workspace/repo',
        branch: 'feature/bitbucket',
        linkedBitbucketPR: 11
      })
    )
    expect(getPRForBranchMock).not.toHaveBeenCalled()
  })

  it('suffixes a selected Bitbucket PR branch when the existing PR is different', async () => {
    getBranchConflictKindMock.mockImplementation(async (_repoPath: string, branch: string) =>
      branch === 'feature/bitbucket' ? 'remote' : null
    )
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/bitbucket-title-2',
        head: 'abc123',
        branch: 'refs/heads/feature/bitbucket-2',
        isBare: false,
        isMainWorktree: false
      }
    ])
    getHostedReviewForBranchMock.mockResolvedValueOnce({
      provider: 'bitbucket',
      number: 12,
      title: 'Different Bitbucket PR',
      state: 'open',
      url: 'https://bitbucket.org/team/repo/pull-requests/12',
      status: 'success',
      updatedAt: '2026-05-21T00:00:00Z',
      mergeable: 'UNKNOWN'
    })

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'bitbucket-title',
      baseBranch: 'abc123',
      branchNameOverride: 'feature/bitbucket',
      linkedBitbucketPR: 11,
      pushTarget: { remoteName: 'origin', branchName: 'feature/bitbucket' }
    })

    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/bitbucket-title-2',
      'feature/bitbucket-2',
      'abc123',
      false
    )
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/bitbucket-title-2',
      expect.objectContaining({ linkedBitbucketPR: 11 })
    )
  })

  it('suffixes a matching push target branch without selected PR metadata', async () => {
    getBranchConflictKindMock.mockImplementation(async (_repoPath: string, branch: string) =>
      branch === 'feature/fix' ? 'remote' : null
    )
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/fix-title-2',
        head: 'abc123',
        branch: 'refs/heads/feature/fix-2',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'fix-title',
      baseBranch: 'abc123',
      branchNameOverride: 'feature/fix',
      pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
    })

    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/fix-title-2',
      'feature/fix-2',
      'abc123',
      false
    )
  })

  it('suffixes a matching push target branch when selected PR metadata has no PR number', async () => {
    getBranchConflictKindMock.mockImplementation(async (_repoPath: string, branch: string) =>
      branch === 'feature/fix' ? 'remote' : null
    )
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/fix-title-2',
        head: 'abc123',
        branch: 'refs/heads/feature/fix-2',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'fix-title',
      baseBranch: 'abc123',
      branchNameOverride: 'feature/fix',
      linkedPR: null,
      pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
    })

    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/fix-title-2',
      'feature/fix-2',
      'abc123',
      false
    )
  })

  it('suffixes a matching push target branch when the existing PR is different', async () => {
    getBranchConflictKindMock.mockImplementation(async (_repoPath: string, branch: string) =>
      branch === 'feature/fix' ? 'remote' : null
    )
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/fix-title-2',
        head: 'abc123',
        branch: 'refs/heads/feature/fix-2',
        isBare: false,
        isMainWorktree: false
      }
    ])
    getPRForBranchMock.mockResolvedValueOnce({
      number: 43,
      title: 'Different PR',
      state: 'open',
      url: 'https://example.com/pr/43',
      checksStatus: 'success',
      updatedAt: '2026-05-21T00:00:00Z',
      mergeable: 'UNKNOWN'
    })

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'fix-title',
      baseBranch: 'abc123',
      branchNameOverride: 'feature/fix',
      linkedPR: 42,
      pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
    })

    expect(getPRForBranchMock).toHaveBeenCalledWith('/workspace/repo', 'feature/fix')
    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/fix-title-2',
      'feature/fix-2',
      'abc123',
      false
    )
  })

  it('suffixes a selected PR remote conflict when the PR lookup fails', async () => {
    getBranchConflictKindMock.mockImplementation(async (_repoPath: string, branch: string) =>
      branch === 'feature/fix' ? 'remote' : null
    )
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/fix-title-2',
        head: 'abc123',
        branch: 'refs/heads/feature/fix-2',
        isBare: false,
        isMainWorktree: false
      }
    ])
    getPRForBranchMock.mockRejectedValueOnce(new Error('gh unavailable'))

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'fix-title',
      baseBranch: 'abc123',
      branchNameOverride: 'feature/fix',
      linkedPR: 42,
      pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
    })

    expect(getPRForBranchMock).toHaveBeenCalledWith('/workspace/repo', 'feature/fix')
    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/fix-title-2',
      'feature/fix-2',
      'abc123',
      false
    )
  })

  it('checks out an unused existing PR branch only when it is at the resolved head SHA', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        return { stdout: 'abc123\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('abc123^{commit}')) {
        return { stdout: 'abc123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    listWorktreesMock
      .mockResolvedValueOnce([
        {
          path: '/workspace/repo',
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
      .mockResolvedValueOnce([
        {
          path: '/workspace/repo',
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/workspace/fix-title',
          head: 'abc123',
          branch: 'refs/heads/feature/fix',
          isBare: false,
          isMainWorktree: false
        }
      ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'fix-title',
      baseBranch: 'abc123',
      branchNameOverride: 'feature/fix'
    })

    expect(getBranchConflictKindMock).not.toHaveBeenCalled()
    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/fix-title',
      'feature/fix',
      'abc123',
      false,
      false,
      { checkoutExistingBranch: true }
    )
  })

  it('suffixes an existing PR branch when its tip differs from the resolved head SHA', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        return { stdout: 'old123\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('abc123^{commit}')) {
        return { stdout: 'abc123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    getBranchConflictKindMock.mockResolvedValueOnce('local')
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/fix-title-2',
        head: 'abc123',
        branch: 'refs/heads/feature/fix-2',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'fix-title',
      baseBranch: 'abc123',
      branchNameOverride: 'feature/fix'
    })

    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/fix-title-2',
      'feature/fix-2',
      'abc123',
      false
    )
  })

  it('skips past a suffix that already belongs to a PR after an initial branch conflict', async () => {
    // Why: the PR-conflict probe (network-bound, 1–3s) only runs from suffix=2 onward, after a branch collision already forced past the first candidate.
    getBranchConflictKindMock.mockImplementation(async (_repoPath: string, branch: string) =>
      branch === 'improve-dashboard' ? 'remote' : null
    )
    getPRForBranchMock.mockImplementation(async (_repoPath: string, branch: string) =>
      branch === 'improve-dashboard-2'
        ? {
            number: 3127,
            title: 'Existing PR',
            state: 'merged',
            url: 'https://example.com/pr/3127',
            checksStatus: 'success',
            updatedAt: '2026-04-01T00:00:00Z',
            mergeable: 'UNKNOWN'
          }
        : null
    )
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard-3',
        head: 'abc123',
        branch: 'improve-dashboard-3',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })

    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/improve-dashboard-3',
      'improve-dashboard-3',
      'origin/main',
      false
    )
    expect(result).toMatchObject({
      worktree: expect.objectContaining({
        path: '/workspace/improve-dashboard-3',
        branch: 'improve-dashboard-3'
      })
    })
  })

  it('does not call `gh pr list` on the happy path (no branch conflict)', async () => {
    // Why: guard against a refactor reintroducing the PR probe on the happy path (1–3s GitHub round-trip per click).
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard',
        head: 'abc123',
        branch: 'improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })

    expect(getPRForBranchMock).not.toHaveBeenCalled()
  })
})
