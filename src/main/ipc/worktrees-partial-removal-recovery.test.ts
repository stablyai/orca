import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listWorktreesMock,
  removeWorktreeMock,
  getSshGitProviderMock,
  getSshFilesystemProviderMock
} from './worktrees-test-module-mocks'
import { handlers, mainWindow, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { makeWorktreeMeta } from './worktrees-test-fixtures'

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
  beforeEach(() => {
    vi.clearAllMocks()
    setupWorktreeHandlers()
  })

  it('purges metadata when remote removeWorktree fails but git registration was already dropped', async () => {
    const repo = {
      id: 'repo-ssh-partial',
      path: '/workspaces/repo',
      displayName: 'repo-ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-partial'
    }
    const worktreePath = '/workspaces/repo/seacucumber'
    const worktreeId = `${repo.id}::${worktreePath}`

    store.getRepo.mockReturnValue(repo)
    store.getWorktreeMeta.mockReturnValue(
      makeWorktreeMeta({ orcaCreatedAt: Date.now(), orcaCreationSource: 'ssh' })
    )

    let listCallCount = 0
    const provider = {
      listWorktrees: vi.fn().mockImplementation(async () => {
        listCallCount++
        if (listCallCount === 1) {
          // First call: worktree is registered before deletion
          return [
            {
              path: repo.path,
              head: 'main',
              branch: 'refs/heads/main',
              isBare: false,
              isMainWorktree: true
            },
            {
              path: worktreePath,
              head: 'sha-seacucumber',
              branch: 'refs/heads/seacucumber',
              isBare: false,
              isMainWorktree: false
            }
          ]
        }
        // Subsequent calls after failed removeWorktree: git registration already gone
        return [
          {
            path: repo.path,
            head: 'main',
            branch: 'refs/heads/main',
            isBare: false,
            isMainWorktree: true
          }
        ]
      }),
      worktreeIsClean: vi.fn().mockResolvedValue({ clean: true }),
      removeWorktree: vi.fn().mockRejectedValue(new Error('Command failed: git worktree remove --force: Directory not empty'))
    }
    getSshGitProviderMock.mockReturnValue(provider)

    const result = await handlers['worktrees:remove'](null, {
      worktreeId,
      force: true
    })

    expect(result).toEqual({})
    expect(provider.removeWorktree).toHaveBeenCalledWith(worktreePath, true)
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'ssh:conn-partial')
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: repo.id
    })
  })

  it('purges metadata when local removeWorktree fails but git registration was already dropped', async () => {
    const repoPath = '/workspace/repo'
    const worktreePath = '/workspace/repo/failed-fs-wt'
    const worktreeId = `repo-1::${worktreePath}`

    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: repoPath,
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0
    })
    store.getWorktreeMeta.mockReturnValue(
      makeWorktreeMeta({ orcaCreatedAt: Date.now(), orcaCreationSource: 'desktop' })
    )

    let listCallCount = 0
    listWorktreesMock.mockImplementation(async () => {
      listCallCount++
      if (listCallCount <= 2) {
        // Initial checks: registered
        return [
          {
            path: repoPath,
            head: 'main',
            branch: 'refs/heads/main',
            isBare: false,
            isMainWorktree: true
          },
          {
            path: worktreePath,
            head: 'sha-123',
            branch: 'refs/heads/feat',
            isBare: false,
            isMainWorktree: false
          }
        ]
      }
      // Recheck after error: git registration dropped
      return [
        {
          path: repoPath,
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ]
    })
    removeWorktreeMock.mockRejectedValue(new Error('EBUSY: resource busy or locked, rmdir'))

    const result = await handlers['worktrees:remove'](null, {
      worktreeId,
      force: true
    })

    expect(result).toEqual({})
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'local')
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: 'repo-1'
    })
  })

  it('cleans up unregistered leftover directory on SSH host and purges metadata', async () => {
    const repo = {
      id: 'repo-ssh-leftover',
      path: '/workspaces/repo',
      displayName: 'ssh-leftover',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-leftover'
    }
    const worktreePath = '/workspaces/repo/leftover-wt'
    const worktreeId = `${repo.id}::${worktreePath}`

    store.getRepo.mockReturnValue(repo)
    store.getWorktreeMeta.mockReturnValue(
      makeWorktreeMeta({ orcaCreatedAt: Date.now(), orcaCreationSource: 'ssh' })
    )

    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: repo.path,
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
    }
    const fsProvider = {
      lstat: vi.fn().mockImplementation(async (path: string) => {
        if (path === worktreePath) {
          return { type: 'directory', isDirectory: () => true }
        }
        // .git is missing
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      }),
      deletePath: vi.fn().mockResolvedValue(undefined)
    }

    getSshGitProviderMock.mockReturnValue(provider)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)

    const result = await handlers['worktrees:remove'](null, {
      worktreeId,
      force: true
    })

    expect(result).toEqual({})
    expect(fsProvider.deletePath).toHaveBeenCalledWith(worktreePath, true)
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'ssh:conn-leftover')
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: repo.id
    })
  })

  it('purges metadata on unregistered directory removal even if physical delete fails', async () => {
    const repo = {
      id: 'repo-ssh-locked',
      path: '/workspaces/repo',
      displayName: 'ssh-locked',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-locked'
    }
    const worktreePath = '/workspaces/repo/locked-wt'
    const worktreeId = `${repo.id}::${worktreePath}`

    store.getRepo.mockReturnValue(repo)
    store.getWorktreeMeta.mockReturnValue(
      makeWorktreeMeta({ orcaCreatedAt: Date.now(), orcaCreationSource: 'ssh' })
    )

    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: repo.path,
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
    }
    const fsProvider = {
      lstat: vi.fn().mockImplementation(async (path: string) => {
        if (path === worktreePath) {
          return { type: 'directory', isDirectory: () => true }
        }
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      }),
      deletePath: vi.fn().mockRejectedValue(new Error('Directory not empty'))
    }

    getSshGitProviderMock.mockReturnValue(provider)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)

    const result = await handlers['worktrees:remove'](null, {
      worktreeId,
      force: true
    })

    expect(result).toEqual({})
    expect(fsProvider.deletePath).toHaveBeenCalledWith(worktreePath, true)
    // Metadata purge must NOT be blocked by the physical filesystem failure
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'ssh:conn-locked')
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: repo.id
    })
  })
})
