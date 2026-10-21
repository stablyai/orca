import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import {
  registerWorktreeRootsForRepo,
  resolveRegisteredWorktreePath
} from './registered-worktree-roots-cache'
import {
  listWorktreesMock,
  removeWorktreeMock,
  getSshFilesystemProviderMock,
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
vi.mock('../providers/ssh-filesystem-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshFilesystemDispatchModuleMock()
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
        // Without the exact id the sweep resolves a selector that no longer exists and stops nothing.
        resolvedWorktreeId: worktreeId,
        resolvedConnectionId: 'ssh-dead',
        localProvider: ptyProvider,
        onPtyStopped: clearProviderPtyStateMock,
        closeStructuredSessions: true,
        includeProviderInventory: false,
        includeLocalRegistry: false
      })
      expect(runtimeStub.clearOptimisticReconcileToken).toHaveBeenCalledWith(worktreeId)
      // The purge must be scoped to the same owner the sweep used, or the ssh:* partition keeps this worktree's session state.
      expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
        hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:ssh-dead' })
      )
      expect(advertisedUrlWatcherForgetWorktreeMock).toHaveBeenCalledWith(worktreeId)
      expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
        repoId: 'repo-1'
      })
      // The whole point: local-only cleanup never dispatches to the SSH provider.
      expect(getSshFilesystemProviderMock).not.toHaveBeenCalled()
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
      // Seed authorized roots while the owning repo still exists, then let it disappear.
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

      // The whole point: a forgotten workspace must not stay filesystem-authorized via cached roots.
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
      // The orphan case forget-local exists for: the meta row is lost, so only the repo still records ownership.
      store.getWorktreeMeta.mockReturnValue(undefined)
      getLocalPtyProviderMock.mockReturnValue({} as never)

      await expect(handlers['worktrees:forgetLocal'](null, { worktreeId })).resolves.toEqual({})

      // Without the resolved owner the purge resolves to [local] only and ssh:ssh-live keeps tabsByWorktree et al. forever.
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

  // Why the refusal: this process stops no SSH terminals, so reaching it proves the SSH row was chosen.
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

    // The SSH owner is selected, so the delete refuses as not served rather than running here.
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
    store.getRepo.mockReturnValue(repo)
    store.getRepos.mockReturnValue([repo])

    // Past the spelling check, the host is refused only because it is not served here.
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

    // Why: this process serves no SSH filesystem, so the SSH host answers error, never local hooks.
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
    const sshRepo = {
      ...localRepo,
      path: '/remote/repo',
      connectionId: 'conn-1'
    }
    store.getRepos.mockReturnValue([localRepo, sshRepo])
    store.getRepo.mockReturnValue(localRepo)

    // Why: this process serves no SSH filesystem, so the SSH host offers no imports.
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
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: worktreeId, hostId: 'local' })
    )
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:conn-1' })
    )
  })
})
