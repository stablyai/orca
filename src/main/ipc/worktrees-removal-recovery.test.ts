import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as localWorktreeFilesystem from '../local-worktree-filesystem'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type { RedactableSpan } from '../observability/redactor'
import { _resetTracerForTests, setActiveSink } from '../observability/tracer'
import {
  ORIGINAL_PLATFORM,
  setPlatform,
  listWorktreesMock,
  removeWorktreeMock,
  getEffectiveHooksMock,
  runHookMock,
  gitExecFileAsyncMock,
  deleteWorktreeHistoryDirMock,
  advertisedUrlWatcherForgetWorktreeMock,
  pruneCleanupScanSnapshotMock,
  pruneSpaceAnalysisSnapshotMock,
  recordRemovalSnapshotPruneMock,
  killAllProcessesForWorktreeMock,
  clearProviderPtyStateMock,
  getLocalPtyProviderMock,
  getSshPtyProviderMock
} from './worktrees-test-module-mocks'
import { handlers, mainWindow, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { makeWorktreeMeta, mockKnownFeatureWorktree } from './worktrees-test-fixtures'
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
  let runtimeStub: WorktreeRuntimeStub

  beforeEach(() => {
    runtimeStub = setupWorktreeHandlers()
  })

  it('prunes the persisted cleanup and space snapshots on removal', async () => {
    mockKnownFeatureWorktree()
    getEffectiveHooksMock.mockReturnValue(null)
    removeWorktreeMock.mockResolvedValue({})

    await handlers['worktrees:remove'](null, { worktreeId: 'repo-1::/workspace/feature-wt' })

    // A removed workspace must never resurrect from the cached scan snapshots.
    expect(pruneCleanupScanSnapshotMock).toHaveBeenCalledWith(
      '/profile-a',
      'repo-1::/workspace/feature-wt',
      'local'
    )
    expect(pruneSpaceAnalysisSnapshotMock).toHaveBeenCalledWith(
      '/profile-a',
      'repo-1::/workspace/feature-wt',
      'local'
    )
  })

  it('tombstones a cleanup-batch removal without scheduling singular sidecar writes', async () => {
    mockKnownFeatureWorktree()
    getEffectiveHooksMock.mockReturnValue(null)
    removeWorktreeMock.mockResolvedValue({})

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt',
      snapshotPruneBatchId: 'cleanup-batch-1'
    })

    expect(recordRemovalSnapshotPruneMock).toHaveBeenCalledExactlyOnceWith('/profile-a', {
      batchId: 'cleanup-batch-1',
      worktreeId: 'repo-1::/workspace/feature-wt',
      executionHostId: 'local'
    })
    expect(pruneCleanupScanSnapshotMock).not.toHaveBeenCalled()
    expect(pruneSpaceAnalysisSnapshotMock).not.toHaveBeenCalled()
  })

  it('traces the removal as worktree.remove with a stage sub-span tree', async () => {
    const records: RedactableSpan[] = []
    setActiveSink({
      push: (record) => records.push(record as RedactableSpan),
      flush: () => {},
      close: () => {}
    })
    try {
      mockKnownFeatureWorktree()
      getEffectiveHooksMock.mockReturnValue(null)
      removeWorktreeMock.mockResolvedValue({})

      await handlers['worktrees:remove'](null, { worktreeId: 'repo-1::/workspace/feature-wt' })

      const parent = records.find((record) => record.name === 'worktree.remove')
      expect(parent).toBeDefined()
      expect(parent?.attributes).toMatchObject({
        kind: 'worktree',
        'worktree.stage': 'remove',
        'worktree.path': '/workspace/feature-wt'
      })
      const stages = records.filter((record) => record.name.startsWith('worktree.remove.'))
      expect(stages.map((record) => record.name)).toEqual(
        expect.arrayContaining([
          'worktree.remove.watcher_gate',
          'worktree.remove.pty_sweep',
          'worktree.remove.git_remove',
          'worktree.remove.metadata_purge',
          'worktree.remove.cache_invalidation'
        ])
      )
      // Stages must hang off the removal span, not float as roots, or a freeze can't be attributed.
      for (const stage of stages) {
        expect(stage.parentSpanId).toBe(parent?.spanId)
        expect(stage.attributes).toMatchObject({ kind: 'worktree', 'worktree.flow': 'local' })
      }
    } finally {
      _resetTracerForTests()
    }
  })

  it('traces a local archive hook as flow local, not remote', async () => {
    const records: RedactableSpan[] = []
    setActiveSink({
      push: (record) => records.push(record as RedactableSpan),
      flush: () => {},
      close: () => {}
    })
    try {
      mockKnownFeatureWorktree()
      // The archive hook block is shared by both flows, so a local repo must not land under 'remote'.
      getEffectiveHooksMock.mockReturnValue({ scripts: { archive: 'pnpm worktree:archive' } })
      runHookMock.mockResolvedValue({ success: true, output: '' })
      removeWorktreeMock.mockResolvedValue({})

      await handlers['worktrees:remove'](null, { worktreeId: 'repo-1::/workspace/feature-wt' })

      const archiveStage = records.find((record) => record.name === 'worktree.remove.archive_hook')
      expect(archiveStage?.attributes).toMatchObject({
        kind: 'worktree',
        'worktree.flow': 'local'
      })
    } finally {
      _resetTracerForTests()
    }
  })

  it('prunes git worktree tracking when removing an orphaned worktree', async () => {
    mockKnownFeatureWorktree()
    const orphanError = Object.assign(new Error('git worktree remove failed'), {
      stderr: "fatal: '/workspace/feature-wt' is not a working tree"
    })
    removeWorktreeMock.mockRejectedValue(orphanError)
    getEffectiveHooksMock.mockReturnValue(null)
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    // Should have called git worktree prune to clean up stale tracking
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'prune'], {
      cwd: '/workspace/repo'
    })
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith('repo-1::/workspace/feature-wt', 'local')
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith('repo-1::/workspace/feature-wt')
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: 'repo-1'
    })
  })

  it('recovers forced Windows long-path worktree removal through local deletion and prune', async () => {
    setPlatform('win32')
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-ipc-long-path-'))
    const repoPath = join(parentDir, 'repo')
    const worktreePath = join(parentDir, 'feature-wt')
    await mkdir(worktreePath, { recursive: true })
    await writeFile(join(worktreePath, 'scratch.txt'), 'delete me')
    const registeredWorktrees = mockKnownFeatureWorktree(worktreePath, repoPath)
    listWorktreesMock
      .mockResolvedValueOnce(registeredWorktrees)
      .mockResolvedValueOnce(registeredWorktrees)
      .mockResolvedValue([])
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta())
    const longPathError = Object.assign(new Error('git worktree remove failed'), {
      stderr: 'error: failed to delete deep/file.txt: Filename too long'
    })
    removeWorktreeMock.mockRejectedValue(longPathError)
    const worktreeId = `repo-1::${worktreePath}`

    try {
      const result = await handlers['worktrees:remove'](null, {
        worktreeId,
        force: true
      })

      expect(result).toEqual({
        preservedBranch: { branchName: 'feature', head: 'feature' }
      })
      if (ORIGINAL_PLATFORM === 'win32') {
        await expect(lstat(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' })
      }
      expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'prune'], {
        cwd: '/workspace/repo'
      })
      expect(store.removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'local')
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
        repoId: 'repo-1'
      })
    } finally {
      await rm(parentDir, { recursive: true, force: true })
    }
  })

  it('does not create a preserved-branch target when long-path recovery preserves branch by policy', async () => {
    setPlatform('win32')
    const registeredWorktrees = mockKnownFeatureWorktree()
    listWorktreesMock
      .mockResolvedValueOnce(registeredWorktrees)
      .mockResolvedValueOnce(registeredWorktrees)
      .mockResolvedValue([])
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta({ preserveBranchOnDelete: true }))
    removeWorktreeMock.mockRejectedValue(
      Object.assign(new Error('git worktree remove failed'), {
        stderr: 'error: failed to delete deep/file.txt: Filename too long'
      })
    )

    const result = await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt',
      force: true
    })

    expect(result).toEqual({})
    await expect(
      handlers['worktrees:forceDeletePreservedBranch'](null, {
        worktreeId: 'repo-1::/workspace/feature-wt',
        branchName: 'feature',
        expectedHead: 'feature'
      })
    ).rejects.toThrow('No preserved branch cleanup is pending')
  })

  it('does not recover Windows long-path worktree removal without force', async () => {
    setPlatform('win32')
    mockKnownFeatureWorktree()
    const longPathError = Object.assign(new Error('git worktree remove failed'), {
      stderr: 'error: failed to delete deep/file.txt: Filename too long'
    })
    removeWorktreeMock.mockRejectedValue(longPathError)

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-1::/workspace/feature-wt'
      })
    ).rejects.toThrow('Failed to delete worktree at /workspace/feature-wt.')

    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('refuses Windows recovery while Git still reports the row and keeps metadata', async () => {
    setPlatform('win32')
    mockKnownFeatureWorktree()
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta())
    const removePathSpy = vi
      .spyOn(localWorktreeFilesystem, 'removeLocalWorktreePath')
      .mockResolvedValue(undefined)
    removeWorktreeMock.mockRejectedValue(
      Object.assign(new Error('git worktree remove failed'), {
        stderr: 'error: failed to delete deep/file.txt: Filename too long'
      })
    )

    try {
      await expect(
        handlers['worktrees:remove'](null, {
          worktreeId: 'repo-1::/workspace/feature-wt',
          force: true
        })
      ).rejects.toThrow(
        'Failed to force delete worktree at /workspace/feature-wt. error: failed to delete deep/file.txt: Filename too long'
      )

      expect(removePathSpy).not.toHaveBeenCalled()
      expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
        ['worktree', 'prune'],
        expect.anything()
      )
      expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
      expect(mainWindow.webContents.send).not.toHaveBeenCalledWith('worktrees:changed', {
        repoId: 'repo-1'
      })
    } finally {
      removePathSpy.mockRestore()
    }
  })

  it('retries stale Git registration cleanup after prior local filesystem recovery', async () => {
    setPlatform('win32')
    const missingWorktreePath = 'C:\\workspace\\already-removed'
    const worktreeId = `repo-1::${missingWorktreePath}`
    const registeredWorktrees = mockKnownFeatureWorktree(missingWorktreePath)
    listWorktreesMock.mockResolvedValueOnce(registeredWorktrees).mockResolvedValue([])
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta())

    const result = await handlers['worktrees:remove'](null, {
      worktreeId,
      force: true
    })

    expect(result).toEqual({
      preservedBranch: { branchName: 'feature', head: 'feature' }
    })
    expect(runHookMock).not.toHaveBeenCalled()
    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'prune'], {
      cwd: '/workspace/repo'
    })
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'local')
  })

  it('preserves a locked missing registration even with force', async () => {
    setPlatform('win32')
    const missingWorktreePath = 'C:\\workspace\\locked-already-removed'
    const worktreeId = `repo-1::${missingWorktreePath}`
    const registeredWorktrees: GitWorktreeInfo[] = [
      {
        path: '/workspace/repo',
        head: 'main',
        branch: 'main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: missingWorktreePath,
        head: 'feature',
        branch: 'feature',
        isBare: false,
        isMainWorktree: false,
        locked: true,
        lockReason: 'active agent session'
      }
    ]
    listWorktreesMock.mockResolvedValue(registeredWorktrees)
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta())
    removeWorktreeMock.mockResolvedValue({})

    await expect(handlers['worktrees:remove'](null, { worktreeId, force: true })).rejects.toThrow(
      'Worktree is locked by Git. Lock reason: active agent session'
    )

    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('refuses to delete the root workspace for folder-mode repos', async () => {
    store.getRepo.mockReturnValue({
      id: 'repo-folder',
      path: '/workspace/folder',
      displayName: 'folder',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'folder'
    })

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-folder::/workspace/folder'
      })
    ).rejects.toThrow('Cannot delete the project root workspace')

    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
    expect(deleteWorktreeHistoryDirMock).not.toHaveBeenCalled()
  })

  it('kills PTYs before removing additional folder workspace metadata', async () => {
    const ptyProvider = {} as never
    const worktreeId = 'repo-folder::/workspace/folder::workspace:child-1'
    store.getRepo.mockReturnValue({
      id: 'repo-folder',
      path: '/workspace/folder',
      displayName: 'folder',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'folder'
    })
    getLocalPtyProviderMock.mockReturnValue(ptyProvider)

    await handlers['worktrees:remove'](null, { worktreeId })

    expect(killAllProcessesForWorktreeMock).toHaveBeenCalledWith(worktreeId, {
      runtime: runtimeStub,
      resolvedWorktreeId: worktreeId,
      localProvider: ptyProvider,
      onPtyStopped: clearProviderPtyStateMock
    })
    expect(killAllProcessesForWorktreeMock.mock.invocationCallOrder[0]).toBeLessThan(
      store.removeWorktreeMeta.mock.invocationCallOrder[0]
    )
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'local')
    expect(advertisedUrlWatcherForgetWorktreeMock).toHaveBeenCalledWith(worktreeId)
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: 'repo-folder'
    })
  })

  // Folder projects can be SSH-backed, and folder workspace ids are `repoId::path::workspace:<uuid>`
  // — reusable across hosts — so the sweep must name the owning connection.
  it('fences an SSH folder workspace PTY sweep to the owning connection', async () => {
    const sshPtyProvider = { id: 'ssh-pty-provider' } as never
    const worktreeId = 'repo-folder::/remote/folder::workspace:child-1'
    store.getRepo.mockReturnValue({
      id: 'repo-folder',
      path: '/remote/folder',
      displayName: 'folder',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'folder',
      connectionId: 'conn-1'
    })
    getSshPtyProviderMock.mockReturnValue(sshPtyProvider)
    // One global meta key can describe the same-id local copy; the resolved repo still owns this delete.
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta({ hostId: 'local' }))

    await handlers['worktrees:remove'](null, { worktreeId })

    expect(getSshPtyProviderMock).toHaveBeenCalledWith('conn-1')
    expect(killAllProcessesForWorktreeMock).toHaveBeenCalledWith(worktreeId, {
      runtime: runtimeStub,
      resolvedWorktreeId: worktreeId,
      resolvedConnectionId: 'conn-1',
      localProvider: sshPtyProvider,
      onPtyStopped: clearProviderPtyStateMock,
      includeProviderInventory: true,
      includeLocalRegistry: false
    })
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'ssh:conn-1')
    expect(advertisedUrlWatcherForgetWorktreeMock).not.toHaveBeenCalled()
    expect(deleteWorktreeHistoryDirMock).not.toHaveBeenCalled()
  })

  it('fences a mirrored runtime folder workspace sweep to its environment', async () => {
    const runtimePtyProvider = {} as never
    const worktreeId = 'repo-folder::/runtime/folder::workspace:child-1'
    store.getRepo.mockReturnValue({
      id: 'repo-folder',
      path: '/runtime/folder',
      displayName: 'folder',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'folder',
      executionHostId: 'runtime:env-1'
    })
    getLocalPtyProviderMock.mockReturnValue(runtimePtyProvider)

    await handlers['worktrees:remove'](null, {
      worktreeId,
      hostId: 'runtime:env-1'
    })

    expect(killAllProcessesForWorktreeMock).toHaveBeenCalledWith(worktreeId, {
      runtime: runtimeStub,
      resolvedWorktreeId: worktreeId,
      resolvedRuntimeEnvironmentId: 'env-1',
      localProvider: runtimePtyProvider,
      onPtyStopped: clearProviderPtyStateMock,
      includeProviderInventory: false,
      includeLocalRegistry: false
    })
    expect(getSshPtyProviderMock).not.toHaveBeenCalled()
  })
})
