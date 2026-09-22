import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSshGitProviderMock, getActiveMultiplexerMock } from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'

function missingShowRefError(): Error & { code: number } {
  return Object.assign(new Error('missing exact ref'), { code: 1 })
}

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

  it('reuses a fresh SSH remote-tracking base refresh for repeated creates', async () => {
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
        if (args[0] === 'show-ref') {
          throw missingShowRefError()
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi
        .fn()
        .mockResolvedValueOnce([
          {
            path: '/remote/repo-first-worktree',
            head: 'abc123',
            branch: 'refs/heads/first-worktree',
            isBare: false,
            isMainWorktree: false
          }
        ])
        .mockResolvedValueOnce([
          {
            path: '/remote/repo-second-worktree',
            head: 'def456',
            branch: 'refs/heads/second-worktree',
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
      name: 'first-worktree'
    })
    await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'second-worktree'
    })

    expect(provider.fetchRemoteTrackingRef).toHaveBeenCalledTimes(1)
    expect(provider.fetchRemoteTrackingRef).toHaveBeenCalledWith(
      '/remote/repo',
      'origin',
      'main',
      'refs/remotes/origin/main',
      { skipAutoMaintenance: true }
    )
    expect(provider.addWorktree).toHaveBeenCalledTimes(2)
  })

  it('skips broad SSH remote fetch for an existing commit SHA base', async () => {
    const sha = 'c'.repeat(40)
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
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        if (args[0] === 'show-ref') {
          throw missingShowRefError()
        }
        if (args[0] === 'for-each-ref') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
          throw new Error('missing local branch')
        }
        if (args[0] === 'rev-parse' && args.includes(`${sha}^{commit}`)) {
          return { stdout: `${sha}\n`, stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo-fix-title',
          head: sha,
          branch: 'refs/heads/feature/fix',
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
      name: 'fix-title',
      baseBranch: sha,
      branchNameOverride: 'feature/fix'
    })

    expect(provider.exec).not.toHaveBeenCalledWith(['fetch', 'origin'], '/remote/repo')
    expect(provider.fetchRemoteTrackingRef).not.toHaveBeenCalled()
    expect(provider.addWorktree).toHaveBeenCalledWith(
      '/remote/repo',
      'feature/fix',
      '/remote/repo-fix-title',
      { base: sha }
    )
  })

  it('shares an in-flight SSH create-base prefetch with create', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: 'origin/main'
    }
    let resolveFetch!: () => void
    const pendingFetch = new Promise<void>((resolve) => {
      resolveFetch = resolve
    })
    const provider = {
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        if (args[0] === 'show-ref') {
          throw missingShowRefError()
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockReturnValue(pendingFetch),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo-prefetched-worktree',
          head: 'abc123',
          branch: 'refs/heads/prefetched-worktree',
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

    const prefetch = handlers['worktrees:prefetchCreateBase'](null, {
      repoId: 'repo-ssh'
    }) as Promise<void>
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(provider.fetchRemoteTrackingRef).toHaveBeenCalledTimes(1)

    const create = handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'prefetched-worktree'
    }) as Promise<unknown>
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(provider.fetchRemoteTrackingRef).toHaveBeenCalledTimes(1)
    expect(provider.addWorktree).not.toHaveBeenCalled()

    resolveFetch()
    await prefetch
    await create

    expect(provider.fetchRemoteTrackingRef).toHaveBeenCalledTimes(1)
    expect(provider.addWorktree).toHaveBeenCalledTimes(1)
  })

  it('registers the SSH repo root before create-base prefetch probes refs', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: 'origin/master'
    }
    const registeredRoots = new Set<string>()
    const events: string[] = []
    const provider = {
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        events.push(`exec:${args[0]}:${registeredRoots.has('/remote/repo')}`)
        if (!registeredRoots.has('/remote/repo')) {
          throw new Error('root not registered')
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
        }
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        if (args[0] === 'show-ref') {
          throw missingShowRefError()
        }
        if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/master^{commit}')) {
          throw new Error('missing stale base')
        }
        if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/main^{commit}')) {
          return { stdout: 'main-sha\n', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo-prefetched-worktree',
          head: 'abc123',
          branch: 'refs/heads/prefetched-worktree',
          isBare: false,
          isMainWorktree: false
        }
      ])
    }
    const mux = {
      request: vi
        .fn()
        .mockImplementation(async (_method: string, payload: { rootPath: string }) => {
          events.push(`register:${payload.rootPath}`)
          registeredRoots.add(payload.rootPath)
        }),
      notify: vi.fn()
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue(mux)
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    await handlers['worktrees:prefetchCreateBase'](null, {
      repoId: 'repo-ssh'
    })
    await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'prefetched-worktree'
    })

    expect(events[0]).toBe('register:/remote/repo')
    expect(events).not.toContain('exec:symbolic-ref:false')
    expect(provider.addWorktree).toHaveBeenCalledWith(
      '/remote/repo',
      'prefetched-worktree',
      '/remote/repo-prefetched-worktree',
      {
        base: 'origin/main'
      }
    )
  })

  it('does not let SSH prefetch turn a persisted slash-named local branch into a remote-tracking base', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: 'team/feature'
    }
    const provider = {
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
        }
        if (args[0] === 'remote') {
          return { stdout: 'team\norigin\n', stderr: '' }
        }
        if (args[0] === 'show-ref') {
          throw missingShowRefError()
        }
        if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/main')) {
          return { stdout: 'main-sha\n', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args.includes('refs/remotes/team/feature^{commit}')) {
          throw new Error('missing remote-tracking ref')
        }
        if (args[0] === 'rev-parse' && args.includes('refs/heads/team/feature^{commit}')) {
          return { stdout: 'team-feature-sha\n', stderr: '' }
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
      request: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue(mux)
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    await handlers['worktrees:prefetchCreateBase'](null, {
      repoId: 'repo-ssh'
    })
    await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'slash-local-base'
    })

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
  })

  it('shares in-flight SSH create-base resolution with create', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: 'origin/main'
    }
    let resolveRemoteList!: () => void
    const pendingRemoteList = new Promise<{ stdout: string; stderr: string }>((resolve) => {
      resolveRemoteList = () => resolve({ stdout: 'origin\n', stderr: '' })
    })
    const provider = {
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote') {
          return pendingRemoteList
        }
        if (args[0] === 'show-ref') {
          throw missingShowRefError()
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo-prefetched-worktree',
          head: 'abc123',
          branch: 'refs/heads/prefetched-worktree',
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

    const prefetch = handlers['worktrees:prefetchCreateBase'](null, {
      repoId: 'repo-ssh'
    }) as Promise<void>
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(provider.exec.mock.calls.filter(([args]) => args[0] === 'remote')).toHaveLength(1)

    const create = handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'prefetched-worktree'
    }) as Promise<unknown>
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(provider.exec.mock.calls.filter(([args]) => args[0] === 'remote')).toHaveLength(1)
    expect(provider.fetchRemoteTrackingRef).not.toHaveBeenCalled()
    expect(provider.addWorktree).not.toHaveBeenCalled()

    resolveRemoteList()
    await prefetch
    await create

    expect(provider.fetchRemoteTrackingRef).toHaveBeenCalledTimes(1)
    expect(provider.addWorktree).toHaveBeenCalledTimes(1)
  })

  it('queues different SSH create-base fetch shapes on the same remote', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: 'origin/main'
    }
    let resolveExactFetch!: () => void
    const pendingExactFetch = new Promise<void>((resolve) => {
      resolveExactFetch = resolve
    })
    const provider = {
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        if (args[0] === 'show-ref') {
          throw missingShowRefError()
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockReturnValue(pendingExactFetch),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo-local-base-worktree',
          head: 'abc123',
          branch: 'refs/heads/local-base-worktree',
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

    const prefetch = handlers['worktrees:prefetchCreateBase'](null, {
      repoId: 'repo-ssh'
    }) as Promise<void>
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(provider.fetchRemoteTrackingRef).toHaveBeenCalledTimes(1)

    const create = handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'local-base-worktree',
      baseBranch: 'local-base'
    }) as Promise<unknown>
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(provider.exec.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(0)
    expect(provider.addWorktree).not.toHaveBeenCalled()

    resolveExactFetch()
    await vi.waitFor(() =>
      expect(provider.exec.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(1)
    )
    await prefetch
    await create

    expect(provider.addWorktree).toHaveBeenCalledTimes(1)
  })
})
