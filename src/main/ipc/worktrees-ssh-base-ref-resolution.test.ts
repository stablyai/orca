import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import {
  resolveDefaultBaseRefViaExecMock,
  getSshGitProviderMock,
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

  it('attempts SSH base cleanup and still removes a sparse worktree when that cleanup fails', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: 'origin/main'
    }
    const setupError = new Error('sparse init failed')
    const provider = {
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        if (args[0] === 'sparse-checkout' && args[1] === 'init') {
          throw setupError
        }
        if (args[0] === 'config' && args[2] === '--unset-all') {
          throw new Error('metadata cleanup failed')
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn()
    }
    const mux = {
      request: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    store.getSparsePresets.mockReturnValue([])
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue(mux)

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-ssh',
        name: 'sparse-dashboard',
        sparseCheckout: {
          directories: ['apps/mobile']
        }
      })
    ).rejects.toThrow('sparse init failed')

    expect(provider.exec).toHaveBeenCalledWith(
      ['config', '--local', '--unset-all', 'branch.sparse-dashboard.base'],
      '/remote/repo-sparse-dashboard'
    )
    expect(provider.removeWorktree).toHaveBeenCalledWith('/remote/repo-sparse-dashboard', true, {
      deleteBranch: true,
      forceBranchDelete: true
    })
  })

  it('keeps an explicit SSH base strict when refresh fails and no local base ref exists', async () => {
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
        if (args[0] === 'fetch') {
          throw new Error('network unavailable')
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockRejectedValue(new Error('network unavailable')),
      addWorktree: vi.fn(),
      listWorktrees: vi.fn()
    }
    const mux = {
      request: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue(mux)

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-ssh',
        name: 'improve-dashboard',
        baseBranch: 'origin/master'
      })
    ).rejects.toThrow(
      'Could not refresh base ref "origin/master" from "origin". Check your network and try again.'
    )

    expect(provider.addWorktree).not.toHaveBeenCalled()
    expect(resolveDefaultBaseRefViaExecMock).not.toHaveBeenCalled()
    expect(provider.fetchRemoteTrackingRef).toHaveBeenCalledWith(
      '/remote/repo',
      'origin',
      'master',
      'refs/remotes/origin/master',
      { skipAutoMaintenance: true }
    )
  })

  it('creates an SSH worktree from the detected default base when the persisted base is stale', async () => {
    // Regression: a stale persisted repo base must fall back to the detected primary default instead of blocking creation.
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: 'origin/master'
    }
    const provider = {
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/master^{commit}')) {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/main^{commit}')) {
          return { stdout: `${'a'.repeat(40)}\n`, stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValueOnce([
        {
          path: '/remote/repo-improve-dashboard',
          head: 'abc123',
          branch: 'refs/heads/improve-dashboard',
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
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'improve-dashboard'
    })

    expect(resolveDefaultBaseRefViaExecMock).toHaveBeenCalled()
    expect(provider.fetchRemoteTrackingRef).toHaveBeenCalledWith(
      '/remote/repo',
      'origin',
      'main',
      'refs/remotes/origin/main',
      { skipAutoMaintenance: true }
    )
    expect(provider.addWorktree).toHaveBeenCalledWith(
      '/remote/repo',
      'improve-dashboard',
      '/remote/repo-improve-dashboard',
      {
        base: 'origin/main'
      }
    )
  })

  it('keeps a usable SSH persisted local branch base after registering the repo root', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: 'develop'
    }
    let repoRootRegistered = false
    const provider = {
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args.includes('refs/heads/develop^{commit}')) {
          return { stdout: repoRootRegistered ? 'develop-sha\n' : '', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo-local-branch-base',
          head: 'develop-sha',
          branch: 'refs/heads/local-branch-base',
          isBare: false,
          isMainWorktree: false
        }
      ])
    }
    const mux = {
      request: vi
        .fn()
        .mockImplementation(async (_method: string, payload: { rootPath: string }) => {
          if (payload.rootPath === repo.path) {
            repoRootRegistered = true
          }
        }),
      notify: vi.fn()
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue(mux)
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'local-branch-base'
    })

    expect(mux.request).toHaveBeenCalledWith('session.registerRoot', { rootPath: repo.path })
    expect(provider.fetchRemoteTrackingRef).not.toHaveBeenCalled()
    expect(provider.addWorktree).toHaveBeenCalledWith(
      '/remote/repo',
      'local-branch-base',
      '/remote/repo-local-branch-base',
      {
        base: 'develop'
      }
    )
  })

  it('keeps a usable SSH slash-named local branch base that matches a remote prefix', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: 'team/feature'
    }
    let repoRootRegistered = false
    const provider = {
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'remote') {
          return { stdout: 'team\norigin\n', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/main')) {
          return { stdout: 'main-sha\n', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args.includes('refs/remotes/team/feature^{commit}')) {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args.includes('refs/heads/team/feature^{commit}')) {
          return { stdout: repoRootRegistered ? 'team-feature-sha\n' : '', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo-slash-local-base',
          head: 'team-feature-sha',
          branch: 'refs/heads/slash-local-base',
          isBare: false,
          isMainWorktree: false
        }
      ])
    }
    const mux = {
      request: vi
        .fn()
        .mockImplementation(async (_method: string, payload: { rootPath: string }) => {
          if (payload.rootPath === repo.path) {
            repoRootRegistered = true
          }
        }),
      notify: vi.fn()
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue(mux)
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'slash-local-base'
    })) as CreateWorktreeResult

    expect(provider.fetchRemoteTrackingRef).not.toHaveBeenCalledWith(
      '/remote/repo',
      'team',
      'feature',
      'refs/remotes/team/feature'
    )
    expect(provider.addWorktree).toHaveBeenCalledWith(
      '/remote/repo',
      'slash-local-base',
      '/remote/repo-slash-local-base',
      {
        base: 'team/feature'
      }
    )
    expect(result.baseFallback).toEqual({
      requestedRef: 'team/feature',
      localRef: 'team/feature'
    })
  })
})
