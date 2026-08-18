import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import {
  registerWorktreeRootsForRepo,
  resolveRegisteredWorktreePath
} from './registered-worktree-roots-cache'
import {
  listWorktreesMock,
  removeWorktreeMock,
  getSshGitProviderMock,
  getSshFilesystemProviderMock,
  deleteWorktreeHistoryDirMock,
  advertisedUrlWatcherForgetWorktreeMock,
  killAllProcessesForWorktreeMock,
  clearProviderPtyStateMock,
  getLocalPtyProviderMock,
  getSshPtyProviderMock
} from './worktrees-test-module-mocks'
import { handlers, mainWindow, setupWorktreeHandlers, store } from './worktrees-test-harness'
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
      // Why: a removed/disconnected SSH target has no live provider; forgetLocal must not reach for one.
      getSshGitProviderMock.mockReturnValue(undefined)
      getSshPtyProviderMock.mockReturnValue(undefined)

      const result = await handlers['worktrees:forgetLocal'](null, { worktreeId })

      expect(result).toEqual({})
      expect(killAllProcessesForWorktreeMock).toHaveBeenCalledWith(worktreeId, {
        runtime: runtimeStub,
        // Without the exact id the sweep resolves a selector that no longer exists and stops nothing.
        resolvedWorktreeId: worktreeId,
        resolvedConnectionId: 'ssh-dead',
        localProvider: ptyProvider,
        onPtyStopped: clearProviderPtyStateMock,
        includeProviderInventory: false,
        includeLocalRegistry: false
      })
      expect(runtimeStub.clearOptimisticReconcileToken).toHaveBeenCalledWith(worktreeId)
      // The purge must be scoped to the same owner the sweep used, or the ssh:* partition keeps this worktree's session state.
      expect(store.removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'ssh:ssh-dead')
      expect(advertisedUrlWatcherForgetWorktreeMock).toHaveBeenCalledWith(worktreeId)
      expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
        repoId: 'repo-1'
      })
      // The whole point: local-only cleanup never dispatches to the SSH provider.
      expect(getSshGitProviderMock).not.toHaveBeenCalled()
      expect(getSshFilesystemProviderMock).not.toHaveBeenCalled()
      expect(listWorktreesMock).not.toHaveBeenCalled()
      expect(removeWorktreeMock).not.toHaveBeenCalled()
    })

    it('sweeps a connected SSH owner through its PTY provider', async () => {
      const worktreeId = 'repo-gone::/workspace/feature-wt'
      const sshProvider = {} as never
      store.getRepos.mockReturnValue([])
      store.getRepo.mockReturnValue(undefined)
      store.getWorktreeMeta.mockReturnValue({ hostId: 'ssh:ssh-live' })
      getSshPtyProviderMock.mockReturnValue(sshProvider)

      await expect(
        handlers['worktrees:forgetLocal'](null, { worktreeId, hostId: 'ssh:ssh-live' })
      ).resolves.toEqual({})

      expect(getSshPtyProviderMock).toHaveBeenCalledWith('ssh-live')
      expect(killAllProcessesForWorktreeMock).toHaveBeenCalledWith(worktreeId, {
        runtime: runtimeStub,
        resolvedWorktreeId: worktreeId,
        resolvedConnectionId: 'ssh-live',
        localProvider: sshProvider,
        onPtyStopped: clearProviderPtyStateMock,
        includeProviderInventory: true,
        includeLocalRegistry: false
      })
      expect(getLocalPtyProviderMock).not.toHaveBeenCalled()
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
      expect(store.removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'runtime:env-1')
      expect(runtimeStub.clearOptimisticReconcileToken).toHaveBeenCalledWith(worktreeId)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
        repoId: 'repo-gone'
      })
      expect(getSshGitProviderMock).not.toHaveBeenCalled()
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
      getSshPtyProviderMock.mockReturnValue(undefined)
      getLocalPtyProviderMock.mockReturnValue({} as never)

      await expect(handlers['worktrees:forgetLocal'](null, { worktreeId })).resolves.toEqual({})

      // Without the resolved owner the purge resolves to [local] only and ssh:ssh-live keeps tabsByWorktree et al. forever.
      expect(store.removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'ssh:ssh-live')
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

      expect(store.removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'local')
      expect(getSshPtyProviderMock).not.toHaveBeenCalled()
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

      expect(store.removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'ssh:removed')
    })
  })
})
