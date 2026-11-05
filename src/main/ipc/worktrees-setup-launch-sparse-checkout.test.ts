import type * as WorktreeScanCacheModule from '../git/worktrees/catalog/worktree-scan-cache'
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
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'

vi.mock('../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: (await import('./worktrees-test-module-mocks')).listWorktreesMock,
    listWorktreesSharedStrictAllowingTrueEmpty: (await import('./worktrees-test-module-mocks'))
      .listWorktreesMock,
    listWorktreesSharedStrict: (await import('./worktrees-test-module-mocks')).listWorktreesMock
  }
})

vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../../shared/git/worktrees/git-worktree-porcelain-parser', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  parseWorktreeList: (await import('./worktrees-test-module-mocks')).parseWorktreeListMock
}))

vi.mock('../git/worktrees/removal/worktree-removal-preflight', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertWorktreeCleanForRemoval: (await import('./worktrees-test-module-mocks'))
    .assertWorktreeCleanForRemovalMock
}))

vi.mock('../git/worktrees/creation/worktree-add', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addWorktree: (await import('./worktrees-test-module-mocks')).addWorktreeMock
}))

vi.mock('../git/worktrees/creation/worktree-sparse-add', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addSparseWorktree: (await import('./worktrees-test-module-mocks')).addSparseWorktreeMock
}))

vi.mock('../git/worktrees/removal/worktree-removal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  removeWorktree: (await import('./worktrees-test-module-mocks')).removeWorktreeMock
}))

vi.mock('../git/worktrees/removal/worktree-branch-removal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  forceDeleteLocalBranch: (await import('./worktrees-test-module-mocks')).forceDeleteLocalBranchMock
}))
vi.mock('../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorktreesStrict: (await import('./worktrees-test-module-mocks')).listWorktreesMock,
  describeCreatedWorktree: (await import('./worktrees-test-module-mocks'))
    .describeCreatedWorktreeMock
}))
const { getWorktreeRunnerMocks } = vi.hoisted(() => {
  function createWorktreeRunnerMocks() {
    return (async () => (await import('./worktrees-test-module-mocks')).gitRunnerModuleMock())()
  }
  let runner: ReturnType<typeof createWorktreeRunnerMocks> | undefined
  return { getWorktreeRunnerMocks: () => (runner ??= createWorktreeRunnerMocks()) }
})

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: (await getWorktreeRunnerMocks()).gitExecFileAsync
}))

vi.mock('../git/command-runner/git-exec-file-sync', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileSync: (await getWorktreeRunnerMocks()).gitExecFileSync
}))
vi.mock('../git/repo', async () =>
  (await import('./worktrees-test-module-mocks')).gitRepoModuleMock()
)

vi.mock('../git/repo-default-base-ref', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBaseRefDefault: (await import('./worktrees-test-module-mocks')).getBaseRefDefaultMock
}))
vi.mock('../git/git-username', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLocalGitUsername: (await import('./worktrees-test-module-mocks'))
    .resolveLocalGitUsernameMock
}))
vi.mock('../github/client', async () =>
  (await import('./worktrees-test-module-mocks')).githubClientModuleMock()
)
vi.mock('../github/client/lookup/get-pr-for-branch', async () =>
  (await import('./worktrees-test-module-mocks')).githubClientModuleMock()
)
vi.mock('../source-control/hosted-review', async () =>
  (await import('./worktrees-test-module-mocks')).hostedReviewModuleMock()
)
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
)

vi.mock('../git/worktrees/content-paths/worktree-symlink-detection', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  findExistingWorktreeSymlinkPaths: (await import('./worktrees-test-module-mocks'))
    .findExistingWorktreeSymlinkPathsMock
}))
vi.mock('../workspace-hooks/hooks', async () =>
  (await import('./worktrees-test-module-mocks')).hooksModuleMock()
)
vi.mock('../workspace-hooks/setup-runner-script-text', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupRunnerScriptTextModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../workspace-hooks/worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../workspace-hooks/effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../workspace-hooks/setup-hook-env-vars', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupHookEnvVarsModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('./worktree-logic', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../pty/history/terminal-history-deletion', async () =>
  (await import('./worktrees-test-module-mocks')).terminalHistoryDeletionModuleMock()
)
vi.mock('../ports/advertised-url-watcher', async () =>
  (await import('./worktrees-test-module-mocks')).advertisedUrlWatcherModuleMock()
)
vi.mock('../workspaces/cleanup/workspace-cleanup-scan-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupScanSnapshotModuleMock()
)
vi.mock('../workspaces/space-analysis/workspace-space-analysis-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceSpaceAnalysisSnapshotModuleMock()
)
vi.mock('../workspaces/cleanup/workspace-cleanup-removal-snapshot-prune', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupRemovalSnapshotPruneModuleMock()
)
vi.mock('../runtime/workspaces/removal/worktree-teardown', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeTeardownModuleMock()
)
vi.mock('./pty/provider/registry', async () =>
  (await import('./worktrees-test-module-mocks')).ptyRegistryModuleMock()
)
vi.mock('./pty/provider/state-cleanup', async () =>
  (await import('./worktrees-test-module-mocks')).ptyStateCleanupModuleMock()
)

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
      false,
      false,
      {}
    )
  })

  it('launches setup even when primary and worktree orca.yaml scripts diverge', async () => {
    // Repo trust gates execution; benign primary/worktree YAML divergence must not disable setup (#1280).
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

    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      sparseCheckout: {
        directories: [' packages/web ', 'apps\\api\\', 'packages/web/'],
        presetId: 'preset-1'
      }
    })) as { timing?: { preparedCheckout?: { status: string; reason?: string } } }

    expect(addWorktreeMock).not.toHaveBeenCalled()
    expect(addSparseWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/improve-dashboard',
      'improve-dashboard',
      ['packages/web', 'apps/api'],
      'origin/main',
      false,
      {}
    )
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: 'repo-1::/workspace/improve-dashboard', hostId: 'local' }),
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
    expect(result.timing?.preparedCheckout).toEqual({
      status: 'miss',
      reason: 'sparse_checkout'
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
      hostWorktreeTarget({ id: 'repo-1::/workspace/improve-dashboard', hostId: 'local' }),
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
      hostWorktreeTarget({ id: 'repo-1::/workspace/improve-dashboard', hostId: 'local' }),
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
