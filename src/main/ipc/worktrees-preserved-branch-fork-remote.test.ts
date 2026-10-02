import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  removeWorktreeMock,
  forceDeleteLocalBranchMock,
  deletePreservedBranchAtHeadMock,
  getHostedReviewForBranchMock,
  gitExecFileAsyncMock,
  getSshGitProviderMock,
  getActiveMultiplexerMock
} from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { makeWorktreeMeta, mockKnownFeatureWorktree } from './worktrees-test-fixtures'

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
  beforeEach(() => {
    setupWorktreeHandlers()
  })

  it('preserves the branch on remove for worktrees created from an existing local branch', async () => {
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue(undefined)
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta({ preserveBranchOnDelete: true }))

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    expect(removeWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/feature-wt',
      false,
      expect.objectContaining({
        deleteBranch: false,
        knownRemovedWorktree: expect.objectContaining({
          branch: 'feature',
          head: 'feature',
          path: '/workspace/feature-wt'
        })
      })
    )
  })

  it('force-deletes a branch that was preserved by safe worktree removal', async () => {
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue({
      preservedBranch: { branchName: 'feature/test', head: 'def456' }
    })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })
    const result = await handlers['worktrees:forceDeletePreservedBranch'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt',
      branchName: 'feature/test',
      expectedHead: 'def456'
    })

    expect(result).toMatchObject({ deleted: true })
    expect(forceDeleteLocalBranchMock).toHaveBeenCalledWith(
      '/workspace/repo',
      'feature/test',
      'def456'
    )
  })

  it('force-deletes a preserved SSH branch without borrowing colliding local metadata', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const worktreeId = 'repo-ssh::/remote/feature-wt'
    const localRepo = { ...repo, path: '/workspace/repo', connectionId: undefined }
    const provider = {
      exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      forceDeletePreservedBranch: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: repo.path,
          head: 'main',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/remote/feature-wt',
          head: 'def456',
          branch: 'feature/test',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue({
        preservedBranch: { branchName: 'feature/test', head: 'def456' }
      }),
      worktreeIsClean: vi.fn().mockResolvedValue({ clean: true })
    }
    store.getRepos.mockReturnValue([localRepo, repo])
    store.getRepo.mockReturnValue(localRepo)
    store.getWorktreeMeta.mockReturnValue(
      makeWorktreeMeta({ hostId: 'local', preserveBranchOnDelete: true })
    )
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue({ request: vi.fn(), notify: vi.fn() })

    await handlers['worktrees:remove'](null, { worktreeId, hostId: 'ssh:conn-1' })
    expect(provider.removeWorktree).toHaveBeenCalledWith('/remote/feature-wt', undefined)
    const result = await handlers['worktrees:forceDeletePreservedBranch'](null, {
      worktreeId,
      branchName: 'feature/test',
      expectedHead: 'def456',
      hostId: 'ssh:conn-1'
    })

    expect(result).toMatchObject({ deleted: true })
    expect(provider.forceDeletePreservedBranch).toHaveBeenCalledWith(
      '/remote/repo',
      'feature/test',
      'def456'
    )
    expect(forceDeleteLocalBranchMock).not.toHaveBeenCalled()
  })

  it('deletes a kept branch whose linked PR merged at that head, before the fork-remote cleanup', async () => {
    deletePreservedBranchAtHeadMock.mockClear()
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue({
      preservedBranch: { branchName: 'feature/test', head: 'def456' }
    })
    const pushTarget = {
      remoteName: 'pr-contributor-orca',
      branchName: 'feature/test',
      remoteUrl: 'https://github.com/contributor/orca.git',
      remoteCreated: true
    }
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta({ linkedPR: 42, pushTarget }))
    getHostedReviewForBranchMock.mockResolvedValue({
      provider: 'github',
      number: 42,
      state: 'merged',
      headSha: 'def456'
    })
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: 'https://github.com/contributor/orca.git\n', stderr: '' }
      }
      if (args[0] === 'config') {
        throw new Error('no branch config')
      }
      return { stdout: '', stderr: '' }
    })

    await handlers['worktrees:remove'](null, { worktreeId: 'repo-1::/workspace/feature-wt' })

    expect(getHostedReviewForBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: '/workspace/repo',
        branch: 'feature/test',
        linkedGitHubPR: 42,
        currentHeadOid: 'def456'
      })
    )
    expect(deletePreservedBranchAtHeadMock).toHaveBeenCalledWith(
      '/workspace/repo',
      'feature/test',
      'def456',
      {}
    )
    const remoteRemoveCall = gitExecFileAsyncMock.mock.calls.findIndex(
      ([args]) => args[0] === 'remote' && args[1] === 'remove'
    )
    expect(remoteRemoveCall).toBeGreaterThanOrEqual(0)
    expect(deletePreservedBranchAtHeadMock.mock.invocationCallOrder[0]).toBeLessThan(
      gitExecFileAsyncMock.mock.invocationCallOrder[remoteRemoveCall]
    )
    await expect(
      handlers['worktrees:forceDeletePreservedBranch'](null, {
        worktreeId: 'repo-1::/workspace/feature-wt',
        branchName: 'feature/test',
        expectedHead: 'def456'
      })
    ).rejects.toThrow('No preserved branch cleanup is pending')
  })

  it('deletes a kept SSH branch through the relay when its review merged at that head', async () => {
    deletePreservedBranchAtHeadMock.mockClear()
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const provider = {
      exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      forceDeletePreservedBranch: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        { path: repo.path, head: 'main', branch: 'main', isBare: false, isMainWorktree: true },
        {
          path: '/remote/feature-wt',
          head: 'def456',
          branch: 'feature/test',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue({
        preservedBranch: { branchName: 'feature/test', head: 'def456' }
      }),
      worktreeIsClean: vi.fn().mockResolvedValue({ clean: true })
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta({ hostId: 'ssh:conn-1' }))
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue({ request: vi.fn(), notify: vi.fn() })
    getHostedReviewForBranchMock.mockResolvedValue({
      provider: 'gitlab',
      number: 5,
      state: 'merged',
      headSha: 'def456'
    })

    const result = await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-ssh::/remote/feature-wt',
      hostId: 'ssh:conn-1'
    })

    expect(result).not.toHaveProperty('preservedBranch')
    expect(getHostedReviewForBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({ executionHostId: 'ssh:conn-1', currentHeadOid: 'def456' })
    )
    expect(provider.forceDeletePreservedBranch).toHaveBeenCalledWith(
      '/remote/repo',
      'feature/test',
      'def456'
    )
    expect(deletePreservedBranchAtHeadMock).not.toHaveBeenCalled()
  })

  it('rejects stale preserved-branch cleanup actions with an old head', async () => {
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue({
      preservedBranch: { branchName: 'feature/test', head: 'new456' }
    })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    await expect(
      handlers['worktrees:forceDeletePreservedBranch'](null, {
        worktreeId: 'repo-1::/workspace/feature-wt',
        branchName: 'feature/test',
        expectedHead: 'old123'
      })
    ).rejects.toThrow('No preserved branch cleanup is pending')
    expect(forceDeleteLocalBranchMock).not.toHaveBeenCalled()
  })

  it('removes an unused Orca-created fork remote after deleting its worktree', async () => {
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue(undefined)
    const pushTarget = {
      remoteName: 'pr-contributor-orca',
      branchName: 'feature/from-fork',
      remoteUrl: 'https://github.com/contributor/orca.git',
      remoteCreated: true
    }
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta({ pushTarget }))
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-1::/workspace/feature-wt': makeWorktreeMeta({ pushTarget })
    })
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'config') {
        throw new Error('no branch config')
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: 'https://github.com/contributor/orca.git\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'remove', 'pr-contributor-orca'], {
      cwd: '/workspace/repo'
    })
  })

  it('keeps an Orca-created fork remote while another worktree still uses it', async () => {
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue(undefined)
    const pushTarget = {
      remoteName: 'pr-contributor-orca',
      branchName: 'feature/from-fork',
      remoteUrl: 'https://github.com/contributor/orca.git',
      remoteCreated: true
    }
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta({ pushTarget }))
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-1::/workspace/feature-wt': makeWorktreeMeta({ pushTarget }),
      'repo-1::/workspace/other-wt': makeWorktreeMeta({
        pushTarget: {
          ...pushTarget,
          branchName: 'other-branch'
        }
      })
    })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      ['remote', 'remove', 'pr-contributor-orca'],
      expect.any(Object)
    )
  })

  it('ignores matching push targets from other repos when deciding fork remote cleanup', async () => {
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue(undefined)
    const pushTarget = {
      remoteName: 'pr-contributor-orca',
      branchName: 'feature/from-fork',
      remoteUrl: 'https://github.com/contributor/orca.git',
      remoteCreated: true
    }
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta({ pushTarget }))
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-1::/workspace/feature-wt': makeWorktreeMeta({ pushTarget }),
      'repo-2::/workspace/other-wt': makeWorktreeMeta({
        pushTarget: {
          ...pushTarget,
          branchName: 'other-branch'
        }
      })
    })
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'config') {
        throw new Error('no branch config')
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: 'https://github.com/contributor/orca.git\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'remove', 'pr-contributor-orca'], {
      cwd: '/workspace/repo'
    })
  })
})
