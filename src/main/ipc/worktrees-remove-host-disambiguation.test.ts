import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  removeWorktreeMock,
  listWorktreesMock,
  parseOrcaYamlMock,
  hasHooksFileMock,
  getSshGitProviderMock,
  getSshFilesystemProviderMock,
  killAllProcessesForWorktreeMock
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

  it('uses the workspace host when duplicate repo ids exist across local and SSH', async () => {
    const localRepo = {
      id: 'repo-shared',
      path: '/local/repo',
      displayName: 'local',
      badgeColor: '#000',
      addedAt: 0,
      worktreeBaseRef: null
    }
    const sshRepo = {
      ...localRepo,
      path: '/remote/repo',
      displayName: 'ssh',
      connectionId: 'conn-1'
    }
    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: sshRepo.path,
          head: 'main',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/remote/feature-wt',
          head: 'feature',
          branch: 'feature',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      worktreeIsClean: vi.fn().mockResolvedValue({ clean: true })
    }
    store.getRepo.mockReturnValue(localRepo)
    store.getRepos.mockReturnValue([localRepo, sshRepo])
    getSshGitProviderMock.mockReturnValue(provider)

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-shared::/remote/feature-wt',
      hostId: 'ssh:conn-1'
    })

    expect(provider.removeWorktree).toHaveBeenCalledWith('/remote/feature-wt', undefined, {
      sharedLinks: { source: '/remote/repo', paths: [] }
    })
    expect(removeWorktreeMock).not.toHaveBeenCalled()
  })

  it('refuses a row whose execution host and connection id name different machines', async () => {
    // #11163: everything below the handler picks the filesystem from `repo.connectionId` while the
    // prune, the archive-hook route and the home guard come from the resolved execution host. This
    // row would have listed a remote checkout on this client and deleted a same-named local path.
    const brokenRepo = {
      id: 'repo-host-only',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: null,
      executionHostId: 'ssh:conn-1' as const
    }
    const provider = {
      listWorktrees: vi.fn(),
      removeWorktree: vi.fn(),
      worktreeIsClean: vi.fn()
    }
    store.getRepo.mockReturnValue(brokenRepo)
    store.getRepos.mockReturnValue([brokenRepo])
    getSshGitProviderMock.mockReturnValue(provider)

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-host-only::/remote/feature-wt',
        force: true
      })
    ).rejects.toThrow(
      'Refusing to delete worktree: repo repo-host-only names execution host ssh:conn-1, but its checkout is only reachable as local.'
    )

    expect(listWorktreesMock).not.toHaveBeenCalled()
    expect(provider.listWorktrees).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
  })

  it('refuses the mirror row that names local while carrying a connection id', async () => {
    const brokenRepo = {
      id: 'repo-local-spelled',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      executionHostId: 'local' as const
    }
    store.getRepo.mockReturnValue(brokenRepo)
    store.getRepos.mockReturnValue([brokenRepo])

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-local-spelled::/remote/feature-wt',
        force: true
      })
    ).rejects.toThrow(
      'Refusing to delete worktree: repo repo-local-spelled names execution host local, but its checkout is only reachable as ssh:conn-1.'
    )
    expect(removeWorktreeMock).not.toHaveBeenCalled()
  })

  it('refuses a row owned by a runtime environment this process does not execute', async () => {
    // `runtime:<env>` deletes on that environment's own server. Its repo row looks local here —
    // `connectionId` is null — so a host id that fell back to "local" would delete a same-named
    // path on this client.
    const runtimeRepo = {
      id: 'repo-runtime-owned',
      path: '/env/repo',
      displayName: 'env',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: null,
      executionHostId: 'runtime:env-1' as const
    }
    store.getRepo.mockReturnValue(runtimeRepo)
    store.getRepos.mockReturnValue([runtimeRepo])

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-runtime-owned::/env/feature-wt',
        force: true
      })
    ).rejects.toThrow('Refusing to delete worktree: repo repo-runtime-owned names execution host')

    expect(listWorktreesMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
  })

  it('accepts a row whose two spellings differ only by percent-escaping', async () => {
    // `getRepoExecutionHostId` returns the stored text while the connection id is re-encoded, so a
    // byte compare would refuse this consistent row over a `%20`.
    const repo = {
      id: 'repo-escaped',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn one',
      executionHostId: 'ssh:conn one' as const
    }
    const provider = {
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
          head: 'feature',
          branch: 'feature',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      worktreeIsClean: vi.fn().mockResolvedValue({ clean: true })
    }
    store.getRepo.mockReturnValue(repo)
    store.getRepos.mockReturnValue([repo])
    getSshGitProviderMock.mockReturnValue(provider)

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-escaped::/remote/feature-wt'
    })

    expect(provider.removeWorktree).toHaveBeenCalledWith('/remote/feature-wt', undefined)
  })

  it('tears down the remote session when an ownerless remote worktree is deleted', async () => {
    const sshRepo = {
      id: 'repo-1',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: sshRepo.path,
          head: 'main',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/remote/feature-wt',
          head: 'feature',
          branch: 'feature',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      worktreeIsClean: vi.fn().mockResolvedValue({ clean: true })
    }
    store.getRepo.mockReturnValue(sshRepo)
    store.getRepos.mockReturnValue([sshRepo])
    getSshGitProviderMock.mockReturnValue(provider)
    // Why: no WorktreeMeta means removal cannot read the owner back; the repo is the only host source.
    store.getWorktreeMeta.mockReturnValue(undefined)

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/remote/feature-wt'
    })

    // The whole point: without the repo's host the ownerless row would clear the local session instead.
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/remote/feature-wt',
      'ssh:conn-1'
    )
  })

  it('fails closed when duplicate repo ids are deleted without a host', async () => {
    const localRepo = {
      id: 'repo-shared',
      path: '/local/repo',
      displayName: 'local',
      badgeColor: '#000',
      addedAt: 0
    }
    const sshRepo = { ...localRepo, path: '/remote/repo', connectionId: 'conn-1' }
    store.getRepos.mockReturnValue([localRepo, sshRepo])

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-shared::/remote/feature-wt'
      })
    ).rejects.toThrow('Repo not found: repo-shared')

    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(getSshGitProviderMock).not.toHaveBeenCalled()
  })

  it('inspects hooks on the requested host when repo ids collide', async () => {
    const localRepo = {
      id: 'repo-shared',
      path: '/local/repo',
      displayName: 'local',
      badgeColor: '#000',
      addedAt: 0
    }
    const sshRepo = { ...localRepo, path: '/remote/repo', connectionId: 'conn-1' }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({
        content: 'scripts:\n  archive: remote-cleanup',
        isBinary: false
      })
    }
    store.getRepos.mockReturnValue([localRepo, sshRepo])
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)
    parseOrcaYamlMock.mockReturnValue({ scripts: { archive: 'remote-cleanup' } })

    await expect(
      handlers['hooks:check'](null, {
        repoId: 'repo-shared',
        hostId: 'ssh:conn-1'
      })
    ).resolves.toEqual({
      status: 'ok',
      hasHooks: true,
      hooks: { scripts: { archive: 'remote-cleanup' } },
      mayNeedUpdate: false
    })
    expect(fsProvider.readFile).toHaveBeenCalledWith('/remote/repo/orca.yaml')
    expect(hasHooksFileMock).not.toHaveBeenCalled()
  })

  it('fails hook inspection closed when duplicate repo ids omit the host', async () => {
    const localRepo = {
      id: 'repo-shared',
      path: '/local/repo',
      displayName: 'local',
      badgeColor: '#000',
      addedAt: 0
    }
    const sshRepo = { ...localRepo, path: '/remote/repo', connectionId: 'conn-1' }
    store.getRepos.mockReturnValue([localRepo, sshRepo])

    await expect(handlers['hooks:check'](null, { repoId: 'repo-shared' })).resolves.toEqual({
      status: 'error',
      hasHooks: false,
      hooks: null,
      mayNeedUpdate: false
    })
    expect(getSshFilesystemProviderMock).not.toHaveBeenCalled()
    expect(hasHooksFileMock).not.toHaveBeenCalled()
  })

  it('inspects setup-script imports on the requested host when repo ids collide', async () => {
    const localRepo = {
      id: 'repo-shared',
      path: '/local/repo',
      displayName: 'local',
      badgeColor: '#000',
      addedAt: 0
    }
    const sshRepo = { ...localRepo, path: '/remote/repo', connectionId: 'conn-1' }
    const fsProvider = {
      readFile: vi.fn(async (filePath: string) => {
        if (filePath === '/remote/repo/.superset/config.json') {
          return { content: '{"setup":"remote setup"}', isBinary: false }
        }
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      }),
      stat: vi.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    }
    store.getRepos.mockReturnValue([localRepo, sshRepo])
    store.getRepo.mockReturnValue(localRepo)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)

    await expect(
      handlers['hooks:inspectSetupScriptImports'](null, {
        repoId: 'repo-shared',
        hostId: 'ssh:conn-1'
      })
    ).resolves.toContainEqual(
      expect.objectContaining({
        provider: 'superset',
        setup: 'remote setup'
      })
    )
    expect(fsProvider.readFile).toHaveBeenCalledWith('/remote/repo/.superset/config.json')
  })

  it('does not coalesce forget requests for the same id on different hosts', async () => {
    const localRepo = {
      id: 'repo-shared',
      path: '/local/repo',
      displayName: 'local',
      badgeColor: '#000',
      addedAt: 0
    }
    const sshRepo = { ...localRepo, path: '/remote/repo', connectionId: 'conn-1' }
    store.getRepos.mockReturnValue([localRepo, sshRepo])
    let finishFirst!: () => void
    killAllProcessesForWorktreeMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = () =>
              resolve({ runtimeStopped: 0, providerStopped: 0, registryStopped: 0 })
          })
      )
      .mockResolvedValueOnce({ runtimeStopped: 0, providerStopped: 0, registryStopped: 0 })

    const first = handlers['worktrees:forgetLocal'](null, {
      worktreeId: 'repo-shared::/same/path',
      hostId: 'local'
    }) as Promise<unknown>
    await vi.waitFor(() => expect(killAllProcessesForWorktreeMock).toHaveBeenCalledTimes(1))

    await expect(
      handlers['worktrees:forgetLocal'](null, {
        worktreeId: 'repo-shared::/same/path',
        hostId: 'ssh:conn-1'
      })
    ).resolves.toEqual({})
    expect(killAllProcessesForWorktreeMock).toHaveBeenCalledTimes(2)

    finishFirst()
    await expect(first).resolves.toEqual({})
  })

  // The repos are gone (host removed), so only the single global meta key is left to
  // key on — and it names one host. It must not merge two hosts' forgets into one.
  it('does not let stale metadata coalesce an explicit host forget onto another host', async () => {
    const worktreeId = 'repo-gone::/same/path'
    store.getRepos.mockReturnValue([])
    store.getRepo.mockReturnValue(undefined)
    store.getWorktreeMeta.mockReturnValue({ hostId: 'local' })
    let finishFirst!: () => void
    killAllProcessesForWorktreeMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = () =>
              resolve({ runtimeStopped: 0, providerStopped: 0, registryStopped: 0 })
          })
      )
      .mockResolvedValueOnce({ runtimeStopped: 0, providerStopped: 0, registryStopped: 0 })

    const first = handlers['worktrees:forgetLocal'](null, {
      worktreeId,
      hostId: 'local'
    }) as Promise<unknown>
    await vi.waitFor(() => expect(killAllProcessesForWorktreeMock).toHaveBeenCalledTimes(1))

    await expect(
      handlers['worktrees:forgetLocal'](null, {
        worktreeId,
        hostId: 'ssh:conn-1'
      })
    ).resolves.toEqual({})
    expect(killAllProcessesForWorktreeMock).toHaveBeenCalledTimes(2)

    finishFirst()
    await expect(first).resolves.toEqual({})
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'local')
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'ssh:conn-1')
  })
})
