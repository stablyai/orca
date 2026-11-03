import type * as WorktreeScanCacheModule from '../git/worktree-scan-cache'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  removeWorktreeMock,
  getEffectiveHooksMock,
  runHookMock,
  gitExecFileAsyncMock,
  deleteWorktreeHistoryDirMock,
  killAllProcessesForWorktreeMock
} from './worktrees-test-module-mocks'
import { handlers, mainWindow, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { makeWorktreeMeta, mockKnownFeatureWorktree } from './worktrees-test-fixtures'
import type { WorktreeRuntimeStub } from './worktrees-test-runtime-stub'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'

vi.mock('../git/worktree-scan-cache', async (importOriginal) => {
  const facade = await vi.importMock<typeof WorktreeScanCacheModule>('../git/worktree')
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: facade.listWorktrees,
    listWorktreesSharedStrictAllowingTrueEmpty: facade.listWorktreesSharedStrictAllowingTrueEmpty
  }
})

vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../git/worktree', async () =>
  (await import('./worktrees-test-module-mocks')).gitWorktreeModuleMock()
)
vi.mock('../git/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorktreesStrict: (await import('./worktrees-test-module-mocks')).listWorktreesMock
}))
vi.mock('../git/runner', async () =>
  (await import('./worktrees-test-module-mocks')).gitRunnerModuleMock()
)
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
vi.mock('../source-control/hosted-review', async () =>
  (await import('./worktrees-test-module-mocks')).hostedReviewModuleMock()
)
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
)
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
vi.mock('../runtime/worktree-teardown', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeTeardownModuleMock()
)
vi.mock('./pty/provider/registry', async () =>
  (await import('./worktrees-test-module-mocks')).ptyRegistryModuleMock()
)
vi.mock('./pty/provider/state-cleanup', async () =>
  (await import('./worktrees-test-module-mocks')).ptyStateCleanupModuleMock()
)

const anyCatalogVersion = { epoch: expect.any(String), sequence: expect.any(Number) }

describe('registerWorktreeHandlers', () => {
  let runtimeStub: WorktreeRuntimeStub

  beforeEach(() => {
    runtimeStub = setupWorktreeHandlers()
  })

  it('reports already-missing unregistered delete paths before teardown, hooks, or git removal', async () => {
    mockKnownFeatureWorktree('/workspace/real-feature')
    getEffectiveHooksMock.mockReturnValue({
      scripts: {
        archive: 'echo archived'
      }
    })

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-1::/workspace/not-a-worktree'
      })
    ).rejects.toThrow(
      'Worktree is no longer registered with Git and its directory is already gone.'
    )

    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
    expect(runHookMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('treats forced deletion of an already-missing unregistered worktree as cleanup', async () => {
    mockKnownFeatureWorktree('/workspace/real-feature')

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/already-deleted-wt',
      force: true
    })

    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
    expect(runHookMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(runtimeStub.clearOptimisticReconcileToken).toHaveBeenCalledWith(
      'repo-1::/workspace/already-deleted-wt'
    )
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: 'repo-1::/workspace/already-deleted-wt', hostId: 'local' })
    )
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(
      'repo-1::/workspace/already-deleted-wt'
    )
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: 'repo-1'
    })
  })

  it('cleans up an already-missing unregistered worktree after force recovery', async () => {
    const worktreeId = 'repo-1::/workspace/already-deleted-wt'
    mockKnownFeatureWorktree('/workspace/real-feature')

    await expect(handlers['worktrees:remove'](null, { worktreeId })).rejects.toThrow(
      'Worktree is no longer registered with Git and its directory is already gone.'
    )

    await handlers['worktrees:remove'](null, { worktreeId, force: true })

    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
    expect(runHookMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(runtimeStub.clearOptimisticReconcileToken).toHaveBeenCalledWith(worktreeId)
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: worktreeId, hostId: 'local' })
    )
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: 'repo-1'
    })
  })

  it('treats normal deletion of an already-missing unregistered worktree as cleanup', async () => {
    mockKnownFeatureWorktree('/workspace/real-feature')
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta())

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/already-deleted-wt'
    })

    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
    expect(runHookMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(runtimeStub.clearOptimisticReconcileToken).toHaveBeenCalledWith(
      'repo-1::/workspace/already-deleted-wt'
    )
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: 'repo-1::/workspace/already-deleted-wt', hostId: 'local' })
    )
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(
      'repo-1::/workspace/already-deleted-wt'
    )
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: 'repo-1'
    })
  })

  it('force-removes a legacy Orca-created orphaned worktree directory after Git tracking is gone', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-ipc-orphan-'))
    const repoPath = join(parentDir, 'repo')
    const orphanPath = join(parentDir, 'orphan')
    const adminWorktreePath = join(repoPath, '.git', 'worktrees', 'orphan')
    const worktreeId = `repo-1::${orphanPath}`
    await mkdir(orphanPath, { recursive: true })
    await mkdir(adminWorktreePath, { recursive: true })
    await writeFile(join(orphanPath, '.git'), `gitdir: ${adminWorktreePath}\n`)
    await writeFile(join(adminWorktreePath, 'gitdir'), `${join(orphanPath, '.git')}\n`)
    const repo = {
      id: 'repo-1',
      path: repoPath,
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      worktreeBaseRef: null
    }
    store.getRepo.mockReturnValue(repo)
    store.getRepos.mockReturnValue([repo])
    mockKnownFeatureWorktree(join(parentDir, 'real-feature'), repoPath)
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta({ createdAt: Date.now() }))

    try {
      await handlers['worktrees:remove'](null, {
        worktreeId,
        force: true
      })

      await expect(lstat(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(killAllProcessesForWorktreeMock).toHaveBeenCalledWith(
        worktreeId,
        expect.objectContaining({ requirePhysicalStop: true })
      )
      expect(runHookMock).not.toHaveBeenCalled()
      expect(removeWorktreeMock).not.toHaveBeenCalled()
      expect(runtimeStub.clearOptimisticReconcileToken).toHaveBeenCalledWith(worktreeId)
      expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
        hostWorktreeTarget({ id: worktreeId, hostId: 'local' })
      )
      expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
        repoId: 'repo-1'
      })
    } finally {
      await rm(parentDir, { recursive: true, force: true })
    }
  })

  it('prompts for force before removing an Orca-created orphaned worktree directory', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-ipc-orphan-'))
    const repoPath = join(parentDir, 'repo')
    const orphanPath = join(parentDir, 'orphan')
    const adminWorktreePath = join(repoPath, '.git', 'worktrees', 'orphan')
    await mkdir(orphanPath, { recursive: true })
    await mkdir(adminWorktreePath, { recursive: true })
    await writeFile(join(orphanPath, '.git'), `gitdir: ${adminWorktreePath}\n`)
    await writeFile(join(adminWorktreePath, 'gitdir'), `${join(orphanPath, '.git')}\n`)
    const repo = {
      id: 'repo-1',
      path: repoPath,
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      worktreeBaseRef: null
    }
    store.getRepo.mockReturnValue(repo)
    store.getRepos.mockReturnValue([repo])
    mockKnownFeatureWorktree(join(parentDir, 'real-feature'), repoPath)
    store.getWorktreeMeta.mockReturnValue(
      makeWorktreeMeta({ orcaCreatedAt: Date.now(), orcaCreationSource: 'runtime' })
    )

    try {
      await expect(
        handlers['worktrees:remove'](null, {
          worktreeId: `repo-1::${orphanPath}`
        })
      ).rejects.toThrow('Worktree is no longer registered with Git but its directory remains.')

      await expect(lstat(orphanPath)).resolves.toBeTruthy()
      expect(removeWorktreeMock).not.toHaveBeenCalled()
      expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
    } finally {
      await rm(parentDir, { recursive: true, force: true })
    }
  })

  it('refuses an Orca-created unregistered directory with no git marker, even forced, until the user removes it', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-ipc-leftover-'))
    const repoPath = join(parentDir, 'repo')
    const leftoverPath = join(parentDir, 'leftover')
    const worktreeId = `repo-1::${leftoverPath}`
    await mkdir(leftoverPath, { recursive: true })
    await writeFile(join(leftoverPath, 'notes.txt'), 'mine\n')
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: repoPath,
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      worktreeBaseRef: null
    })
    mockKnownFeatureWorktree(join(parentDir, 'real-feature'), repoPath)
    store.getWorktreeMeta.mockReturnValue(
      makeWorktreeMeta({ orcaCreatedAt: Date.now(), orcaCreationSource: 'runtime' })
    )
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') {
        throw new Error('fatal: not a git repository')
      }
      return { stdout: '', stderr: '' }
    })

    try {
      for (const force of [false, true]) {
        await expect(handlers['worktrees:remove'](null, { worktreeId, force })).rejects.toThrow(
          `Refusing to delete unregistered worktree path: ${leftoverPath}`
        )
      }
      await expect(readFile(join(leftoverPath, 'notes.txt'), 'utf8')).resolves.toBe('mine\n')
      expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
      expect(removeWorktreeMock).not.toHaveBeenCalled()
      expect(store.removeWorktreeMeta).not.toHaveBeenCalled()

      await rm(leftoverPath, { recursive: true, force: true })
      await expect(handlers['worktrees:remove'](null, { worktreeId })).resolves.toEqual({
        catalogVersion: anyCatalogVersion
      })
      expect(removeWorktreeMock).not.toHaveBeenCalled()
      expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
        hostWorktreeTarget({ id: worktreeId, hostId: 'local' })
      )
    } finally {
      await rm(parentDir, { recursive: true, force: true })
    }
  })

  it('rejects an Orca-created unregistered local directory with a git directory', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-ipc-standalone-'))
    const repoPath = join(parentDir, 'repo')
    const standalonePath = join(parentDir, 'standalone')
    await mkdir(join(standalonePath, '.git'), { recursive: true })
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: repoPath,
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      worktreeBaseRef: null
    })
    mockKnownFeatureWorktree(join(parentDir, 'real-feature'), repoPath)
    store.getWorktreeMeta.mockReturnValue(
      makeWorktreeMeta({ orcaCreatedAt: Date.now(), orcaCreationSource: 'runtime' })
    )

    try {
      await expect(
        handlers['worktrees:remove'](null, {
          worktreeId: `repo-1::${standalonePath}`,
          force: true
        })
      ).rejects.toThrow(`Refusing to delete unregistered worktree path: ${standalonePath}`)

      await expect(lstat(standalonePath)).resolves.toBeTruthy()
      expect(removeWorktreeMock).not.toHaveBeenCalled()
      expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
    } finally {
      await rm(parentDir, { recursive: true, force: true })
    }
  })

  it('does not inspect or delete a local path for an SSH orphan this process does not serve', async () => {
    const localPath = await mkdtemp(join(tmpdir(), 'orca-ipc-ssh-missing-fs-'))
    const repo = {
      id: 'repo-ssh-missing-fs',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-missing-fs'
    }
    store.getRepo.mockReturnValue(repo)
    store.getWorktreeMeta.mockReturnValue(
      makeWorktreeMeta({ orcaCreatedAt: Date.now(), orcaCreationSource: 'ssh' })
    )

    try {
      await expect(
        handlers['worktrees:remove'](null, {
          worktreeId: `${repo.id}::${localPath}`,
          force: true
        })
      ).rejects.toThrow('isn’t served by Orca’s server')

      await expect(lstat(localPath)).resolves.toBeTruthy()
      expect(removeWorktreeMock).not.toHaveBeenCalled()
      expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
    } finally {
      await rm(localPath, { recursive: true, force: true })
    }
  })
})
