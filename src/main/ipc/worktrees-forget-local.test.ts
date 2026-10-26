import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import {
  registerWorktreeRootsForRepo,
  resolveRegisteredWorktreePath
} from './registered-worktree-roots-cache'
import {
  listWorktreesMock,
  removeWorktreeMock,
  deleteWorktreeHistoryDirMock,
  advertisedUrlWatcherForgetWorktreeMock,
  killAllProcessesForWorktreeMock,
  clearProviderPtyStateMock,
  getLocalPtyProviderMock,
  hasHooksFileMock
} from './worktrees-test-module-mocks'
import { handlers, mainWindow, setupWorktreeHandlers, store } from './worktrees-test-harness'
import type { WorktreeRuntimeStub } from './worktrees-test-runtime-stub'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'

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
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
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
vi.mock('./pty/provider/registry', async () =>
  (await import('./worktrees-test-module-mocks')).ptyRegistryModuleMock()
)
vi.mock('./pty/provider/state-cleanup', async () =>
  (await import('./worktrees-test-module-mocks')).ptyStateCleanupModuleMock()
)

describe('registerWorktreeHandlers', () => {
  let runtimeStub: WorktreeRuntimeStub

  beforeEach(() => {
    runtimeStub = setupWorktreeHandlers()
  })

  describe('worktrees:forgetLocal', () => {
    it('forgets a workspace pinned to a removed SSH target without touching the provider', async () => {
      const repo = {
        id: 'repo-1',
        path: '/workspace/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: 'ssh-dead',
        worktreeBaseRef: null
      }
      const ptyProvider = {} as never
      const worktreeId = 'repo-1::/workspace/feature-wt'
      store.getRepos.mockReturnValue([repo])
      store.getRepo.mockReturnValue(repo)
      getLocalPtyProviderMock.mockReturnValue(ptyProvider)

      const result = await handlers['worktrees:forgetLocal'](null, { worktreeId })

      expect(result).toEqual({})
      expect(killAllProcessesForWorktreeMock).toHaveBeenCalledWith(worktreeId, {
        runtime: runtimeStub,
        // The selector no longer exists, so teardown needs its exact ID.
        resolvedWorktreeId: worktreeId,
        resolvedConnectionId: 'ssh-dead',
        localProvider: ptyProvider,
        onPtyStopped: clearProviderPtyStateMock,
        closeStructuredSessions: true,
        includeProviderInventory: false,
        includeLocalRegistry: false
      })
      expect(runtimeStub.clearOptimisticReconcileToken).toHaveBeenCalledWith(worktreeId)
      // Purge the swept host partition; otherwise remote session state survives.
      expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
        hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:ssh-dead' })
      )
      expect(advertisedUrlWatcherForgetWorktreeMock).toHaveBeenCalledWith(worktreeId)
      expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
        repoId: 'repo-1'
      })
      expect(listWorktreesMock).not.toHaveBeenCalled()
      expect(removeWorktreeMock).not.toHaveBeenCalled()
    })

    it('purges metadata after a rejected best-effort PTY sweep', async () => {
      const worktreeId = 'repo-1::/workspace/feature-wt'
      killAllProcessesForWorktreeMock.mockRejectedValue(new Error('terminal inventory unavailable'))

      await expect(handlers['worktrees:forgetLocal'](null, { worktreeId })).resolves.toEqual({})

      expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
        hostWorktreeTarget({ id: worktreeId, hostId: 'local' })
      )
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
        repoId: 'repo-1'
      })
      expect(store.removeWorktreeMeta.mock.invocationCallOrder[0]).toBeLessThan(
        mainWindow.webContents.send.mock.invocationCallOrder[0]
      )
      expect(removeWorktreeMock).not.toHaveBeenCalled()
    })

    it('forgets an ownerless workspace after its repo is already gone', async () => {
      const worktreeId = 'repo-gone::/workspace/feature-wt'
      const worktreePath = '/workspace/feature-wt'
      store.getRepos.mockReturnValue([
        {
          id: 'repo-gone',
          path: '/workspace/gone',
          displayName: 'gone',
          badgeColor: '#000',
          addedAt: 0
        }
      ])
      registerWorktreeRootsForRepo(store as never, 'repo-gone', [worktreePath])
      await expect(resolveRegisteredWorktreePath(worktreePath, store as never)).resolves.toBe(
        resolve(worktreePath)
      )
      store.getRepos.mockReturnValue([])
      store.getRepo.mockReturnValue(undefined)

      await expect(
        handlers['worktrees:forgetLocal'](null, {
          worktreeId,
          hostId: 'runtime:env-1'
        })
      ).resolves.toEqual({})

      await expect(resolveRegisteredWorktreePath(worktreePath, store as never)).rejects.toThrow(
        'Access denied: unknown repository or worktree path'
      )
      expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
        hostWorktreeTarget({ id: worktreeId, hostId: 'runtime:env-1' })
      )
      expect(runtimeStub.clearOptimisticReconcileToken).toHaveBeenCalledWith(worktreeId)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
        repoId: 'repo-gone'
      })
      expect(removeWorktreeMock).not.toHaveBeenCalled()
    })

    it('purges the SSH owner partition for a hostId-less forget whose worktreeMeta row is already gone', async () => {
      const repo = {
        id: 'repo-ssh',
        path: '/workspace/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        executionHostId: 'ssh:ssh-live' as const,
        connectionId: 'ssh-live',
        worktreeBaseRef: null
      }
      const worktreeId = 'repo-ssh::/workspace/feature-wt'
      store.getRepos.mockReturnValue([repo])
      store.getRepo.mockReturnValue(repo)
      store.getWorktreeMeta.mockReturnValue(undefined)
      getLocalPtyProviderMock.mockReturnValue({} as never)

      await expect(handlers['worktrees:forgetLocal'](null, { worktreeId })).resolves.toEqual({})

      expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
        hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:ssh-live' })
      )
    })

    it('rejects an unqualified forget when the repo id has owners on two hosts', async () => {
      const localRepo = {
        id: 'repo-shared',
        path: '/workspace/local',
        displayName: 'local',
        badgeColor: '#000',
        addedAt: 0
      }
      const sshRepo = {
        ...localRepo,
        path: '/workspace/remote',
        connectionId: 'ssh-live'
      }
      const worktreeId = 'repo-shared::/workspace/feature-wt'
      store.getRepos.mockReturnValue([localRepo, sshRepo])
      store.getRepo.mockReturnValue(localRepo)
      store.getWorktreeMeta.mockReturnValue({ hostId: 'local' })

      await expect(handlers['worktrees:forgetLocal'](null, { worktreeId })).rejects.toThrow(
        'Workspace identity is ambiguous across hosts'
      )

      expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
      expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
    })

    it('scopes the purge to a local folder workspace owner', async () => {
      const repo = {
        id: 'repo-folder-child',
        path: '/workspace/folder',
        displayName: 'folder',
        badgeColor: '#000',
        addedAt: 0,
        kind: 'folder' as const
      }
      const worktreeId = 'repo-folder-child::/workspace/folder/child'
      store.getRepos.mockReturnValue([repo])
      store.getRepo.mockReturnValue(repo)
      store.getWorktreeMeta.mockReturnValue(undefined)
      getLocalPtyProviderMock.mockReturnValue({} as never)

      await expect(handlers['worktrees:forgetLocal'](null, { worktreeId })).resolves.toEqual({})

      expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
        hostWorktreeTarget({ id: worktreeId, hostId: 'local' })
      )
    })

    it('rejects forgetting a folder project root', async () => {
      const repo = {
        id: 'repo-folder',
        path: '/workspace/folder',
        displayName: 'folder',
        badgeColor: '#000',
        addedAt: 0,
        kind: 'folder' as const
      }
      store.getRepo.mockReturnValue(repo)

      await expect(
        handlers['worktrees:forgetLocal'](null, {
          worktreeId: `${repo.id}::${repo.path}`
        })
      ).rejects.toThrow(/project root workspace/)

      expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
      expect(deleteWorktreeHistoryDirMock).not.toHaveBeenCalled()
    })

    it('does not apply another host folder root guard to an explicit missing owner', async () => {
      const localRepo = {
        id: 'repo-folder',
        path: '/workspace/folder',
        displayName: 'folder',
        badgeColor: '#000',
        addedAt: 0,
        kind: 'folder' as const
      }
      const worktreeId = `${localRepo.id}::${localRepo.path}`
      store.getRepos.mockReturnValue([localRepo])
      store.getRepo.mockReturnValue(undefined)
      store.getWorktreeMeta.mockReturnValue({ hostId: 'ssh:removed' })
      getLocalPtyProviderMock.mockReturnValue({} as never)

      await expect(
        handlers['worktrees:forgetLocal'](null, { worktreeId, hostId: 'ssh:removed' })
      ).resolves.toEqual({})

      expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
        hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:removed' })
      )
    })
  })
})

describe('worktree execution-host disambiguation', () => {
  beforeEach(() => {
    setupWorktreeHandlers()
  })

  it('routes to the workspace host when duplicate repo ids exist across local and SSH', async () => {
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
    store.getRepo.mockReturnValue(localRepo)
    store.getRepos.mockReturnValue([localRepo, sshRepo])

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-shared::/remote/feature-wt',
        hostId: 'ssh:conn-1'
      })
    ).rejects.toThrow(SshHostNotServedError)

    expect(listWorktreesMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
  })

  it('refuses a row whose execution host and connection id name different machines', async () => {
    // Contradictory routing and guard ownership could delete a remote path on this client (#11163).
    const brokenRepo = {
      id: 'repo-host-only',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: null,
      executionHostId: 'ssh:conn-1' as const
    }
    store.getRepo.mockReturnValue(brokenRepo)
    store.getRepos.mockReturnValue([brokenRepo])

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-host-only::/remote/feature-wt',
        force: true
      })
    ).rejects.toThrow(
      'Refusing to delete worktree: repo repo-host-only names execution host ssh:conn-1, but its checkout is only reachable as local.'
    )

    expect(listWorktreesMock).not.toHaveBeenCalled()
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
    // Runtime rows can have null connectionId; treating them as local risks deleting a same-named client path.
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
    // Compare decoded host names so equivalent percent-escapes cannot cause false refusals.
    const repo = {
      id: 'repo-escaped',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn one',
      executionHostId: 'ssh:conn one' as const
    }
    store.getRepo.mockReturnValue(repo)
    store.getRepos.mockReturnValue([repo])

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-escaped::/remote/feature-wt'
      })
    ).rejects.toThrow(SshHostNotServedError)
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
  })

  it('inspects hooks on the requested host when repo ids collide', async () => {
    const localRepo = {
      id: 'repo-shared',
      path: '/local/repo',
      displayName: 'local',
      badgeColor: '#000',
      addedAt: 0
    }
    const sshRepo = {
      ...localRepo,
      path: '/remote/repo',
      connectionId: 'conn-1'
    }
    store.getRepos.mockReturnValue([localRepo, sshRepo])

    await expect(
      handlers['hooks:check'](null, {
        repoId: 'repo-shared',
        hostId: 'ssh:conn-1'
      })
    ).resolves.toEqual({
      status: 'error',
      hasHooks: false,
      hooks: null,
      mayNeedUpdate: false
    })
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
    const sshRepo = {
      ...localRepo,
      path: '/remote/repo',
      connectionId: 'conn-1'
    }
    store.getRepos.mockReturnValue([localRepo, sshRepo])
    store.getRepo.mockReturnValue(localRepo)

    await expect(
      handlers['hooks:inspectSetupScriptImports'](null, {
        repoId: 'repo-shared',
        hostId: 'ssh:conn-1'
      })
    ).resolves.toEqual([])
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

  // Global metadata may name only one host; explicit host forgets must still remain separate.
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
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: worktreeId, hostId: 'local' })
    )
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:conn-1' })
    )
  })
})
