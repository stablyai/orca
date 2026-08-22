import { beforeEach, describe, expect, it, vi } from 'vitest'
import { validateGitExecArgs } from '../../relay/git-exec-validator'
import { getSshGitProviderMock, getActiveMultiplexerMock } from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'

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

  it('adds the fork remote for an SSH fork-PR worktree through git.exec', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: 'origin/main'
    }
    // Why: run every exec through the relay's own validator so a create shape the
    // relay rejects fails here instead of on the user's SSH host.
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      validateGitExecArgs(args)
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: 'git@github.com:stablyai/orca.git\n', stderr: '' }
      }
      if (args[0] === 'remote' && args.length === 1) {
        return { stdout: 'origin\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const provider = {
      exec,
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo-contributor-fix',
          head: 'abc123',
          branch: 'refs/heads/contributor/fix',
          isBare: false,
          isMainWorktree: false
        }
      ])
    }
    const mux = { request: vi.fn().mockResolvedValue(undefined), notify: vi.fn() }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue(mux)
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'contributor-fix',
      branchNameOverride: 'contributor/fix',
      pushTarget: {
        remoteName: 'pr-contributor-orca',
        branchName: 'contributor/fix',
        remoteUrl: 'https://github.com/contributor/orca.git'
      }
    })

    expect(exec).toHaveBeenCalledWith(
      ['remote', 'add', 'pr-contributor-orca', 'https://github.com/contributor/orca.git'],
      '/remote/repo'
    )
    expect(provider.fetchRemoteTrackingRef).toHaveBeenCalledWith(
      '/remote/repo',
      'pr-contributor-orca',
      'contributor/fix',
      'refs/remotes/pr-contributor-orca/contributor/fix'
    )
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        pushTarget: {
          remoteName: 'pr-contributor-orca',
          branchName: 'contributor/fix',
          remoteUrl: 'https://github.com/contributor/orca.git',
          remoteCreated: true
        }
      })
    )
  })

  it('names the relay upgrade when an older host still rejects the fork remote', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: 'origin/main'
    }
    const provider = {
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote' && args[1] === 'add') {
          throw new Error('Destructive git remote operations are not allowed via exec')
        }
        if (args[0] === 'remote' && args[1] === 'get-url') {
          return { stdout: 'git@github.com:stablyai/orca.git\n', stderr: '' }
        }
        if (args[0] === 'remote' && args.length === 1) {
          return { stdout: 'origin\n', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([])
    }
    const mux = { request: vi.fn().mockResolvedValue(undefined), notify: vi.fn() }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue(mux)

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-ssh',
        name: 'contributor-fix',
        branchNameOverride: 'contributor/fix',
        pushTarget: {
          remoteName: 'pr-contributor-orca',
          branchName: 'contributor/fix',
          remoteUrl: 'https://github.com/contributor/orca.git'
        }
      })
    ).rejects.toThrow('Reconnect to deploy the latest relay')
    expect(provider.addWorktree).not.toHaveBeenCalled()
  })

  it('drops the fork remote it just added when the SSH head fetch fails', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: 'origin/main'
    }
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      validateGitExecArgs(args)
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: 'git@github.com:stablyai/orca.git\n', stderr: '' }
      }
      if (args[0] === 'remote' && args.length === 1) {
        return { stdout: 'origin\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const provider = {
      exec,
      fetchRemoteTrackingRef: vi
        .fn()
        .mockImplementation(async (_repoPath: string, remote: string) => {
          if (remote === 'pr-contributor-orca') {
            throw new Error('network unreachable')
          }
        }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([])
    }
    const mux = { request: vi.fn().mockResolvedValue(undefined), notify: vi.fn() }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue(mux)

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-ssh',
        name: 'contributor-fix',
        branchNameOverride: 'contributor/fix',
        pushTarget: {
          remoteName: 'pr-contributor-orca',
          branchName: 'contributor/fix',
          remoteUrl: 'https://github.com/contributor/orca.git'
        }
      })
    ).rejects.toThrow('network unreachable')

    expect(exec).toHaveBeenCalledWith(['remote', 'remove', 'pr-contributor-orca'], '/remote/repo')
    expect(provider.addWorktree).not.toHaveBeenCalled()
  })
})
