import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getSshGitProviderMock,
  getSshFilesystemProviderMock,
  killAllProcessesForWorktreeMock
} from './worktrees-test-module-mocks'
import { handlers, mainWindow, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { makeWorktreeMeta } from './worktrees-test-fixtures'
import { validateGitExecArgs } from '../../relay/git-exec-validator'

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

describe('worktrees partial removal recovery', () => {
  const repo = {
    id: 'repo-ssh',
    path: '/workspaces/repo',
    displayName: 'repo-ssh',
    badgeColor: '#000',
    addedAt: 0,
    connectionId: 'conn-1'
  }
  const hostId = 'ssh:conn-1'
  const mainWorktree = {
    path: repo.path,
    head: 'main',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true
  }

  beforeEach(() => {
    vi.clearAllMocks()
    setupWorktreeHandlers()
    store.getRepo.mockReturnValue(repo)
    store.getWorktreeMeta.mockReturnValue(
      makeWorktreeMeta({ orcaCreatedAt: Date.now(), orcaCreationSource: 'ssh' })
    )
  })

  describe('registered remote worktree', () => {
    const worktreePath = '/workspaces/repo/seacucumber'
    const worktreeId = `${repo.id}::${worktreePath}`
    const featureWorktree = {
      path: worktreePath,
      head: 'sha-seacucumber',
      branch: 'refs/heads/seacucumber',
      isBare: false,
      isMainWorktree: false
    }

    function mockProvider(afterFailure: () => Promise<unknown>) {
      const provider = {
        listWorktrees: vi
          .fn()
          .mockResolvedValueOnce([mainWorktree, featureWorktree])
          .mockImplementation(afterFailure),
        worktreeIsClean: vi.fn().mockResolvedValue({ clean: true }),
        removeWorktree: vi
          .fn()
          .mockRejectedValue(new Error("error: failed to delete '…': Directory not empty"))
      }
      getSshGitProviderMock.mockReturnValue(provider)
      return provider
    }

    it('purges metadata when git already dropped the registration', async () => {
      const provider = mockProvider(async () => [mainWorktree])

      await handlers['worktrees:remove'](null, { worktreeId, force: true })

      expect(provider.removeWorktree).toHaveBeenCalledWith(worktreePath, true)
      expect(store.removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, hostId)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
        repoId: repo.id
      })
    })

    it('keeps the record when git still lists the worktree', async () => {
      mockProvider(async () => [mainWorktree, featureWorktree])

      await expect(handlers['worktrees:remove'](null, { worktreeId, force: true })).rejects.toThrow(
        'Directory not empty'
      )
      expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
    })

    it('keeps the record when the follow-up listing cannot be read', async () => {
      mockProvider(async () => {
        throw new Error('SSH connection lost')
      })

      await expect(handlers['worktrees:remove'](null, { worktreeId, force: true })).rejects.toThrow(
        'Directory not empty'
      )
      expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
    })

    it('does not treat a terminal teardown failure as a removal', async () => {
      const provider = mockProvider(async () => [mainWorktree])
      killAllProcessesForWorktreeMock.mockRejectedValueOnce(new Error('PTY teardown failed'))

      await expect(handlers['worktrees:remove'](null, { worktreeId, force: true })).rejects.toThrow(
        'PTY teardown failed'
      )
      expect(provider.removeWorktree).not.toHaveBeenCalled()
      expect(provider.listWorktrees).toHaveBeenCalledTimes(1)
      expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
    })
  })

  describe('unregistered remote leftover', () => {
    const worktreePath = '/workspaces/repo/leftover-wt'
    const worktreeId = `${repo.id}::${worktreePath}`
    const directory = { type: 'directory', isDirectory: () => true }

    function mockLeftover(exec: () => Promise<unknown>, deletePath = vi.fn()) {
      const provider = {
        listWorktrees: vi.fn().mockResolvedValue([mainWorktree]),
        exec: vi.fn().mockImplementation(exec)
      }
      const missing = async (path: string) => {
        if (path === worktreePath) {
          return directory
        }
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      }
      const fsProvider = {
        lstat: vi.fn().mockImplementation(missing),
        stat: vi.fn().mockImplementation(missing),
        deletePath
      }
      getSshGitProviderMock.mockReturnValue(provider)
      getSshFilesystemProviderMock.mockReturnValue(fsProvider)
      return { provider, fsProvider }
    }

    const notARepository = async () => {
      throw new Error('fatal: not a git repository (or any of the parent directories): .git')
    }

    it('deletes an Orca leftover that no git repository encloses', async () => {
      const { provider, fsProvider } = mockLeftover(
        notARepository,
        vi.fn().mockResolvedValue(undefined)
      )

      await handlers['worktrees:remove'](null, { worktreeId, force: true })

      expect(provider.exec).toHaveBeenCalledWith(
        ['rev-parse', '--is-inside-work-tree'],
        worktreePath
      )
      // The probe must pass the relay's git.exec allowlist, or every retry is refused.
      expect(() => validateGitExecArgs(provider.exec.mock.calls[0][0])).not.toThrow()
      expect(fsProvider.deletePath).toHaveBeenCalledWith(worktreePath, true)
      expect(store.removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, hostId)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
        repoId: repo.id
      })
    })

    it.each([
      ['still inside a git repository', async () => ({ stdout: '/workspaces/.git\n', stderr: '' })],
      [
        'inside a repository git refused to read',
        async () => {
          throw new Error(
            "fatal: detected dubious ownership in repository at '/srv/not a git repository'"
          )
        }
      ],
      [
        'past a filesystem boundary git stopped at',
        async () => {
          throw new Error(
            'fatal: not a git repository (or any parent up to mount point /workspaces)'
          )
        }
      ],
      [
        'unverifiable because the probe failed',
        async () => {
          throw new Error('SSH connection lost')
        }
      ]
    ])('refuses the recursive delete when the leftover is %s', async (_label, exec) => {
      const { fsProvider } = mockLeftover(exec)

      await expect(handlers['worktrees:remove'](null, { worktreeId, force: true })).rejects.toThrow(
        'Refusing to delete unregistered worktree path'
      )
      expect(fsProvider.deletePath).not.toHaveBeenCalled()
      expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
    })

    it('keeps the record retryable when the remote delete fails', async () => {
      const { fsProvider } = mockLeftover(
        notARepository,
        vi.fn().mockRejectedValue(new Error('Directory not empty'))
      )

      await expect(handlers['worktrees:remove'](null, { worktreeId, force: true })).rejects.toThrow(
        'Directory not empty'
      )
      expect(fsProvider.deletePath).toHaveBeenCalledWith(worktreePath, true)
      expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
    })
  })
})
