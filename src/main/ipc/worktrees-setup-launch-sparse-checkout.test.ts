import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listWorktreesMock,
  addWorktreeMock,
  addSparseWorktreeMock,
  getEffectiveHooksMock,
  createSetupRunnerScriptMock,
  getEffectiveHooksFromConfigMock,
  shouldRunSetupForCreateMock
} from './worktrees-test-module-mocks'
import { handlers, mainWindow, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { createdWorktreeList } from './worktrees-test-fixtures'

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

  it('returns a setup launch payload when setup should run', async () => {
    listWorktreesMock.mockResolvedValue(createdWorktreeList)
    getEffectiveHooksMock.mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    shouldRunSetupForCreateMock.mockReturnValue(true)

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      setupDecision: 'run'
    })

    expect(createSetupRunnerScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1' }),
      '/workspace/improve-dashboard',
      'pnpm worktree:setup',
      undefined,
      undefined
    )
    expect(result).toMatchObject({
      worktree: expect.objectContaining({
        repoId: 'repo-1',
        path: '/workspace/improve-dashboard',
        branch: 'improve-dashboard'
      }),
      setup: {
        runnerScriptPath: '/workspace/repo/.git/orca/setup-runner.sh',
        envVars: {
          ORCA_ROOT_PATH: '/workspace/repo',
          ORCA_WORKTREE_PATH: '/workspace/improve-dashboard'
        }
      }
    })
    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/improve-dashboard',
      'improve-dashboard',
      'origin/main',
      false
    )
  })

  it('launches setup even when primary and worktree orca.yaml scripts diverge', async () => {
    // Why: benign orca.yaml divergence must not disable setup (regression from #1280 content-equality gate); repo trust already gates execution.
    listWorktreesMock.mockResolvedValue(createdWorktreeList)
    getEffectiveHooksMock.mockImplementation((_repo, worktreePath?: string) => ({
      scripts: {
        setup: worktreePath ? 'pnpm worktree:setup # worktree' : 'pnpm worktree:setup'
      }
    }))
    getEffectiveHooksFromConfigMock.mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup # worktree'
      }
    })
    shouldRunSetupForCreateMock.mockReturnValue(true)

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      setupDecision: 'run'
    })

    expect(createSetupRunnerScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1' }),
      '/workspace/improve-dashboard',
      'pnpm worktree:setup # worktree',
      undefined,
      undefined
    )
    expect(result).toEqual(
      expect.objectContaining({
        setup: expect.objectContaining({
          runnerScriptPath: '/workspace/repo/.git/orca/setup-runner.sh'
        })
      })
    )
  })

  it('creates a sparse worktree and persists its sparse metadata', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        ...createdWorktreeList[0],
        isSparse: true
      }
    ])
    store.setWorktreeMeta.mockReturnValue({
      sparseDirectories: ['packages/web', 'apps/api'],
      sparseBaseRef: 'origin/main',
      sparsePresetId: 'preset-1'
    })
    store.getSparsePresets.mockReturnValue([
      {
        id: 'preset-1',
        repoId: 'repo-1',
        name: 'Frontend and API',
        directories: ['packages/web', 'apps/api'],
        createdAt: 1,
        updatedAt: 1
      }
    ])

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      sparseCheckout: {
        directories: [' packages/web ', 'apps\\api\\', 'packages/web/'],
        presetId: 'preset-1'
      }
    })

    expect(addWorktreeMock).not.toHaveBeenCalled()
    expect(addSparseWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/improve-dashboard',
      'improve-dashboard',
      ['packages/web', 'apps/api'],
      'origin/main',
      false
    )
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/improve-dashboard',
      expect.objectContaining({
        sparseDirectories: ['packages/web', 'apps/api'],
        sparseBaseRef: 'origin/main',
        sparsePresetId: 'preset-1'
      })
    )
    expect(result).toMatchObject({
      worktree: expect.objectContaining({
        repoId: 'repo-1',
        path: '/workspace/improve-dashboard',
        sparseDirectories: ['packages/web', 'apps/api'],
        sparseBaseRef: 'origin/main',
        sparsePresetId: 'preset-1'
      })
    })
  })

  it('retires a generated sparse name when creation rollback also fails', async () => {
    addSparseWorktreeMock.mockRejectedValueOnce(
      Object.assign(new Error('sparse setup failed'), { cleanupFailed: true })
    )

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'nautilus',
        nameWasGenerated: true,
        sparseCheckout: { directories: ['packages/web'] }
      })
    ).rejects.toThrow('sparse setup failed')

    expect(store.addRetiredWorktreeName).toHaveBeenCalledWith('repo-1', 'nautilus')
  })

  it('clears sparse preset attribution when the preset id does not belong to the repo', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        ...createdWorktreeList[0],
        isSparse: true
      }
    ])
    store.getSparsePresets.mockReturnValue([
      {
        id: 'preset-2',
        repoId: 'repo-1',
        name: 'Other preset',
        directories: ['packages/web'],
        createdAt: 1,
        updatedAt: 1
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      sparseCheckout: {
        directories: ['packages/web'],
        presetId: 'preset-1'
      }
    })

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/improve-dashboard',
      expect.objectContaining({
        sparseDirectories: ['packages/web'],
        sparseBaseRef: 'origin/main',
        sparsePresetId: undefined
      })
    )
  })

  it('clears sparse preset attribution when normalized directories do not match', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        ...createdWorktreeList[0],
        isSparse: true
      }
    ])
    store.getSparsePresets.mockReturnValue([
      {
        id: 'preset-1',
        repoId: 'repo-1',
        name: 'Frontend and API',
        directories: ['packages/web', 'apps/api'],
        createdAt: 1,
        updatedAt: 1
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      sparseCheckout: {
        directories: ['packages/web'],
        presetId: 'preset-1'
      }
    })

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/improve-dashboard',
      expect.objectContaining({
        sparseDirectories: ['packages/web'],
        sparseBaseRef: 'origin/main',
        sparsePresetId: undefined
      })
    )
  })

  it('rejects sparse checkout directories that traverse above the repo root', async () => {
    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'improve-dashboard',
        sparseCheckout: {
          directories: ['packages/web', '../secrets']
        }
      })
    ).rejects.toThrow('Sparse checkout directories must be repo-relative paths.')

    expect(addSparseWorktreeMock).not.toHaveBeenCalled()
    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it.each(['/Users/me/repo/packages/web', 'C:\\repo\\packages\\web', '\\\\server\\share\\repo'])(
    'rejects absolute sparse checkout directory before normalization: %s',
    async (directory) => {
      await expect(
        handlers['worktrees:create'](null, {
          repoId: 'repo-1',
          name: 'improve-dashboard',
          sparseCheckout: {
            directories: ['packages/web', directory]
          }
        })
      ).rejects.toThrow('Sparse checkout directories must be repo-relative paths.')

      expect(addSparseWorktreeMock).not.toHaveBeenCalled()
      expect(addWorktreeMock).not.toHaveBeenCalled()
    }
  )

  it('still returns the created worktree when setup runner generation fails', async () => {
    listWorktreesMock.mockResolvedValue(createdWorktreeList)
    getEffectiveHooksMock.mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    shouldRunSetupForCreateMock.mockReturnValue(true)
    createSetupRunnerScriptMock.mockImplementation(() => {
      throw new Error('disk full')
    })

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      setupDecision: 'run'
    })

    expect(result).toMatchObject({
      worktree: expect.objectContaining({
        repoId: 'repo-1',
        path: '/workspace/improve-dashboard',
        branch: 'improve-dashboard'
      })
    })
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: 'repo-1'
    })
  })
})
