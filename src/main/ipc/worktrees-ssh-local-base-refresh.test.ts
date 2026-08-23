import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
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

  it('returns SSH local base refresh skip status when the owning worktree is dirty', async () => {
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
        if (args[0] === 'merge-base') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'log') {
          return { stdout: 'commit-a\ncommit-b\ncommit-c\n', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi
        .fn()
        .mockResolvedValueOnce([
          {
            path: '/remote/repo',
            head: 'base123',
            branch: 'refs/heads/main',
            isBare: false,
            isMainWorktree: true
          }
        ])
        .mockResolvedValueOnce([
          {
            path: '/remote/repo-improve-dashboard',
            head: 'abc123',
            branch: 'refs/heads/improve-dashboard',
            isBare: false,
            isMainWorktree: false
          }
        ]),
      worktreeIsClean: vi.fn().mockResolvedValue({ clean: false, stdout: ' M package.json\n' }),
      refreshLocalBaseRefForWorktreeCreate: vi.fn().mockResolvedValue(undefined)
    }
    const mux = {
      request: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    }
    store.getSettings.mockReturnValue({
      branchPrefix: 'none',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: true,
      workspaceDir: '/workspace'
    })
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue(mux)
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'improve-dashboard'
    })) as CreateWorktreeResult

    expect(provider.exec).toHaveBeenCalledWith(
      ['merge-base', '--is-ancestor', 'refs/heads/main', 'refs/remotes/origin/main'],
      '/remote/repo'
    )
    expect(provider.exec).toHaveBeenCalledWith(
      ['log', '--format=%H', 'refs/heads/main..refs/remotes/origin/main'],
      '/remote/repo'
    )
    expect(provider.worktreeIsClean).toHaveBeenCalledWith('/remote/repo', {
      includeUntracked: false
    })
    expect(provider.exec).not.toHaveBeenCalledWith(
      ['reset', '--hard', 'refs/remotes/origin/main'],
      expect.any(String)
    )
    expect(provider.refreshLocalBaseRefForWorktreeCreate).not.toHaveBeenCalled()
    expect(result).toEqual(
      expect.objectContaining({
        localBaseRefRefresh: {
          status: 'skipped_dirty_worktree',
          baseRef: 'origin/main',
          localBranch: 'main',
          ownerWorktreePath: '/remote/repo'
        }
      })
    )
  })

  it('refreshes SSH local base through the narrow relay RPC when the setting is on', async () => {
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
        if (args[0] === 'merge-base') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'log') {
          return { stdout: 'commit-a\ncommit-b\n', stderr: '' }
        }
        throw new Error(`unexpected generic exec: ${args.join(' ')}`)
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi
        .fn()
        .mockResolvedValueOnce([
          {
            path: '/remote/repo',
            head: 'base123',
            branch: 'refs/heads/main',
            isBare: false,
            isMainWorktree: true
          }
        ])
        .mockResolvedValueOnce([
          {
            path: '/remote/repo-improve-dashboard',
            head: 'abc123',
            branch: 'refs/heads/improve-dashboard',
            isBare: false,
            isMainWorktree: false
          }
        ]),
      worktreeIsClean: vi.fn().mockResolvedValue({ clean: true }),
      refreshLocalBaseRefForWorktreeCreate: vi.fn().mockResolvedValue(undefined)
    }
    const mux = {
      request: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    }
    store.getSettings.mockReturnValue({
      branchPrefix: 'none',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: true,
      workspaceDir: '/workspace'
    })
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue(mux)
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'improve-dashboard'
    })) as CreateWorktreeResult

    expect(provider.exec).toHaveBeenCalledWith(
      ['merge-base', '--is-ancestor', 'refs/heads/main', 'refs/remotes/origin/main'],
      '/remote/repo'
    )
    expect(provider.exec).toHaveBeenCalledWith(
      ['log', '--format=%H', 'refs/heads/main..refs/remotes/origin/main'],
      '/remote/repo'
    )
    expect(provider.refreshLocalBaseRefForWorktreeCreate).toHaveBeenCalledWith({
      repoPath: '/remote/repo',
      fullRef: 'refs/heads/main',
      remoteTrackingRef: 'refs/remotes/origin/main',
      ownerWorktreePath: '/remote/repo'
    })
    expect(provider.exec).not.toHaveBeenCalledWith(
      ['reset', '--hard', 'refs/remotes/origin/main'],
      expect.any(String)
    )
    expect(provider.exec).not.toHaveBeenCalledWith(
      ['update-ref', 'refs/heads/main', 'refs/remotes/origin/main'],
      expect.any(String)
    )
    expect(result).toEqual(
      expect.objectContaining({
        localBaseRefRefresh: {
          status: 'updated',
          baseRef: 'origin/main',
          localBranch: 'main',
          ownerWorktreePath: '/remote/repo'
        }
      })
    )
  })

  it('returns SSH local base update suggestion when a full local base ref is safely behind', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: 'refs/remotes/origin/main'
    }
    let registeredRoots = false
    const provider = {
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        if (args[0] === 'merge-base' || args[0] === 'log') {
          if (!registeredRoots) {
            throw new Error('Path outside authorized workspace')
          }
          return {
            stdout: args[0] === 'log' ? 'commit-a\ncommit-b\ncommit-c\ncommit-d\n' : '',
            stderr: ''
          }
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockImplementation(async () => {
        if (!registeredRoots) {
          throw new Error('No workspace roots registered yet')
        }
        return [
          {
            path: '/remote/repo',
            head: 'base123',
            branch: 'refs/heads/main',
            isBare: false,
            isMainWorktree: true
          },
          {
            path: '/remote/repo-improve-dashboard',
            head: 'abc123',
            branch: 'refs/heads/improve-dashboard',
            isBare: false,
            isMainWorktree: false
          }
        ]
      }),
      worktreeIsClean: vi.fn().mockImplementation(async () => {
        if (!registeredRoots) {
          throw new Error('Path outside authorized workspace')
        }
        return { clean: true }
      }),
      refreshLocalBaseRefForWorktreeCreate: vi.fn().mockResolvedValue(undefined)
    }
    const mux = {
      request: vi.fn().mockImplementation(async (method: string) => {
        if (method === 'session.registerRoot') {
          registeredRoots = true
        }
      }),
      notify: vi.fn()
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue(mux)
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'improve-dashboard'
    })

    expect(provider.exec).toHaveBeenCalledWith(
      ['merge-base', '--is-ancestor', 'refs/heads/main', 'refs/remotes/origin/main'],
      '/remote/repo'
    )
    expect(provider.exec).toHaveBeenCalledWith(
      ['log', '--format=%H', 'refs/heads/main..refs/remotes/origin/main'],
      '/remote/repo'
    )
    expect(provider.listWorktrees).toHaveBeenCalledWith('/remote/repo')
    expect(provider.worktreeIsClean).toHaveBeenCalledWith('/remote/repo', {
      includeUntracked: false
    })
    expect(provider.refreshLocalBaseRefForWorktreeCreate).toHaveBeenCalledWith({
      repoPath: '/remote/repo',
      fullRef: 'refs/heads/main',
      remoteTrackingRef: 'refs/remotes/origin/main',
      ownerWorktreePath: '/remote/repo',
      checkOnly: true
    })
    expect(provider.exec).not.toHaveBeenCalledWith(
      ['reset', '--hard', 'refs/remotes/origin/main'],
      expect.any(String)
    )
    expect(result).toEqual(
      expect.objectContaining({
        localBaseRefUpdateSuggestion: {
          baseRef: 'origin/main',
          localBranch: 'main',
          behind: 4
        }
      })
    )
  })

  it('does not suggest SSH local base updates when the relay cannot refresh local refs', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: 'refs/remotes/origin/main'
    }
    const methodNotFound = Object.assign(
      new Error('Method not found: git.refreshLocalBaseRefForWorktreeCreate'),
      { code: -32601 }
    )
    const provider = {
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        if (args[0] === 'merge-base') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'log') {
          return { stdout: 'commit-a\n', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi
        .fn()
        .mockResolvedValueOnce([
          {
            path: '/remote/repo',
            head: 'base123',
            branch: 'refs/heads/main',
            isBare: false,
            isMainWorktree: true
          }
        ])
        .mockResolvedValueOnce([
          {
            path: '/remote/repo-improve-dashboard',
            head: 'abc123',
            branch: 'refs/heads/improve-dashboard',
            isBare: false,
            isMainWorktree: false
          }
        ]),
      worktreeIsClean: vi.fn().mockResolvedValue({ clean: true }),
      refreshLocalBaseRefForWorktreeCreate: vi.fn().mockRejectedValue(methodNotFound)
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

    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'improve-dashboard'
    })) as CreateWorktreeResult

    expect(provider.refreshLocalBaseRefForWorktreeCreate).toHaveBeenCalledWith({
      repoPath: '/remote/repo',
      fullRef: 'refs/heads/main',
      remoteTrackingRef: 'refs/remotes/origin/main',
      ownerWorktreePath: '/remote/repo',
      checkOnly: true
    })
    expect(result.localBaseRefUpdateSuggestion).toBeUndefined()
  })
  // #15331: the pre-create merge-base probe fails when refs/heads/<branch> does not exist yet.
  const buildMissingLocalBaseSshCase = (presence: 'absent' | 'present' | 'probe-failed') => {
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
        if (args[0] === 'for-each-ref' && args.at(-1) === 'refs/heads/main') {
          if (presence === 'probe-failed') {
            throw new Error('ssh: connection closed by remote host')
          }
          return { stdout: presence === 'present' ? 'refs/heads/main\n' : '', stderr: '' }
        }
        if (args[0] === 'rev-parse') {
          const ref = args.at(-1) ?? ''
          if (ref.startsWith('refs/heads/main')) {
            return { stdout: presence === 'present' ? 'local-main\n' : '', stderr: '' }
          }
          // Other refs/heads probes are the new-branch conflict check; it must stay unresolvable.
          return { stdout: ref.startsWith('refs/heads/') ? '' : 'remote-main\n', stderr: '' }
        }
        if (args[0] === 'merge-base') {
          throw new Error('fatal: Not a valid object name refs/heads/main')
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo-improve-dashboard',
          head: 'abc123',
          branch: 'refs/heads/improve-dashboard',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      worktreeIsClean: vi.fn().mockResolvedValue({ clean: true }),
      refreshLocalBaseRefForWorktreeCreate: vi.fn().mockResolvedValue(undefined)
    }
    store.getSettings.mockReturnValue({
      branchPrefix: 'none',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: true,
      workspaceDir: '/workspace'
    })
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue({
      request: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    })
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)
    return provider
  }

  it('does not report an SSH local base refresh when the local base branch does not exist', async () => {
    const provider = buildMissingLocalBaseSshCase('absent')

    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'improve-dashboard'
    })) as CreateWorktreeResult

    expect(provider.exec).toHaveBeenCalledWith(
      ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/heads/main'],
      '/remote/repo'
    )
    expect(result.localBaseRefRefresh).toBeUndefined()
    expect(provider.refreshLocalBaseRefForWorktreeCreate).not.toHaveBeenCalled()
  })

  it('keeps the SSH not-fast-forward status when the local base branch exists and diverged', async () => {
    const provider = buildMissingLocalBaseSshCase('present')

    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'improve-dashboard'
    })) as CreateWorktreeResult

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_not_fast_forward',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
    expect(provider.refreshLocalBaseRefForWorktreeCreate).not.toHaveBeenCalled()
  })

  // Losing the relay mid-probe is not evidence the branch is missing.
  it('keeps the SSH not-fast-forward status when the local base ref probe fails', async () => {
    const provider = buildMissingLocalBaseSshCase('probe-failed')

    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'improve-dashboard'
    })) as CreateWorktreeResult

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_not_fast_forward',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
    expect(provider.refreshLocalBaseRefForWorktreeCreate).not.toHaveBeenCalled()
  })
})
