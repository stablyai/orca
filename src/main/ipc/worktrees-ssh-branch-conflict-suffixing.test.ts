import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getSshGitProviderMock,
  getSshFilesystemProviderMock,
  getActiveMultiplexerMock
} from './worktrees-test-module-mocks'
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

  it('suffixes only the SSH worktree path when an exact PR branch checkout path exists', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: 'abc123'
    }
    const provider = {
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
          return { stdout: 'abc123\n', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args.includes('abc123^{commit}')) {
          return { stdout: 'abc123\n', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi
        .fn()
        .mockResolvedValueOnce([
          {
            path: '/remote/repo',
            head: 'main',
            branch: 'refs/heads/main',
            isBare: false,
            isMainWorktree: true
          }
        ])
        .mockResolvedValueOnce([
          {
            path: '/remote/repo',
            head: 'main',
            branch: 'refs/heads/main',
            isBare: false,
            isMainWorktree: true
          }
        ])
        .mockResolvedValueOnce([
          {
            path: '/remote/repo-fix-title-2',
            head: 'abc123',
            branch: 'refs/heads/feature/fix',
            isBare: false,
            isMainWorktree: false
          }
        ])
    }
    const fsProvider = {
      stat: vi.fn().mockImplementation(async (pathValue: string) => {
        if (pathValue === '/remote/repo-fix-title') {
          return { size: 0, type: 'directory', mtime: 0 }
        }
        const error = new Error('missing') as Error & { code: string }
        error.code = 'ENOENT'
        throw error
      }),
      readFile: vi.fn().mockRejectedValue(new Error('missing'))
    }
    const mux = {
      request: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)
    getActiveMultiplexerMock.mockReturnValue(mux)

    await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'fix-title',
      baseBranch: 'abc123',
      branchNameOverride: 'feature/fix'
    })

    expect(provider.addWorktree).toHaveBeenCalledWith(
      '/remote/repo',
      'feature/fix',
      '/remote/repo-fix-title-2',
      { checkoutExistingBranch: true }
    )
    expect(mux.request).toHaveBeenCalledWith('session.registerRoot', {
      rootPath: '/remote/repo-fix-title-2'
    })
  })

  it('suffixes SSH worktree creation when the requested branch already exists on a remote', async () => {
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
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        if (args[0] === 'branch' && args.includes('feature/something')) {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'for-each-ref') {
          return { stdout: 'refs/remotes/origin/feature/something\n', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/something^{commit}')) {
          throw new Error('missing local branch')
        }
        if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/something-2^{commit}')) {
          throw new Error('missing local branch')
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo-feature-something-2',
          head: 'abc123',
          branch: 'refs/heads/feature/something-2',
          isBare: false,
          isMainWorktree: false
        }
      ])
    }
    const mux = {
      request: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue(mux)

    await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'feature-something',
      branchNameOverride: 'feature/something'
    })

    expect(provider.addWorktree).toHaveBeenCalledWith(
      '/remote/repo',
      'feature/something-2',
      '/remote/repo-feature-something-2',
      { base: 'origin/main' }
    )
  })

  it('suffixes SSH worktree creation when a slashed remote owns the requested branch', async () => {
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
        if (args[0] === 'remote') {
          return { stdout: 'origin\nfoo/bar\n', stderr: '' }
        }
        if (args[0] === 'for-each-ref') {
          return { stdout: 'refs/remotes/foo/bar/feature/something\n', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/something^{commit}')) {
          throw new Error('missing local branch')
        }
        if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/something-2^{commit}')) {
          throw new Error('missing local branch')
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo-feature-something-2',
          head: 'abc123',
          branch: 'refs/heads/feature/something-2',
          isBare: false,
          isMainWorktree: false
        }
      ])
    }
    const mux = {
      request: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue(mux)

    await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'feature-something',
      branchNameOverride: 'feature/something'
    })

    expect(provider.addWorktree).toHaveBeenCalledWith(
      '/remote/repo',
      'feature/something-2',
      '/remote/repo-feature-something-2',
      { base: 'origin/main' }
    )
  })
})
