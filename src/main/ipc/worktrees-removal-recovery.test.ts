import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as diskFs from 'node:fs/promises'
import * as gitRunner from '../git/runner'
import { removeWorktree } from '../git/worktree'
import { removeWorktree as removeNativeWorktree } from '../git/worktree-removal'
import { readTranslatedWorktreeGraph } from '../git/worktree-list-reader'
import { toHostFilesystemPath } from '../host-tree-removal'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import * as scopedRootsInvalidation from './registered-worktree-roots-scoped-invalidation'
import * as authorizedRootsCache from './registered-worktree-roots-cache'
import * as localWorktreeFilesystem from '../local-worktree-filesystem'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type { RedactableSpan } from '../observability/redactor'
import type { Store } from '../persistence'
import { _resetTracerForTests, setActiveSink } from '../observability/tracer'
import { agentHookServer } from '../agent-hooks/server'
import { makePaneKey } from '../../shared/stable-pane-id'
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
  getLocalPtyProviderMock
} from './worktrees-test-module-mocks'
import {
  handlers,
  harnessRepo,
  mainWindow,
  setupWorktreeHandlers,
  store
} from './worktrees-test-harness'
import { makeWorktreeMeta, mockKnownFeatureWorktree } from './worktrees-test-fixtures'
import type { WorktreeRuntimeStub } from './worktrees-test-runtime-stub'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'

vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../git/worktree', async () =>
  (await import('./worktrees-test-module-mocks')).gitWorktreeModuleMock()
)
vi.mock('../git/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof gitRunner>()),
  ...(await import('./worktrees-test-module-mocks')).gitRunnerModuleMock()
}))
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

const actualGitRunner = await vi.importActual<typeof gitRunner>('../git/runner')
const anyCatalogVersion = { epoch: expect.any(String), sequence: expect.any(Number) }

describe('registerWorktreeHandlers', () => {
  let runtimeStub: WorktreeRuntimeStub

  beforeEach(() => {
    runtimeStub = setupWorktreeHandlers()
    vi.spyOn(scopedRootsInvalidation, 'invalidateAuthorizedRootsCacheForRepo').mockClear()
    vi.spyOn(authorizedRootsCache, 'invalidateAuthorizedRootsCache').mockClear()
  })

  it('prunes the persisted cleanup and space snapshots on removal', async () => {
    mockKnownFeatureWorktree()
    getEffectiveHooksMock.mockReturnValue(null)
    removeWorktreeMock.mockResolvedValue({})
    const unrelatedRepo = { ...harnessRepo, id: 'repo-2', path: '/unrelated/repo' }
    store.getRepos.mockReturnValue([harnessRepo, unrelatedRepo])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this existing IPC store fixture supplies the repository, project, folder, and settings methods the root registry reads.
    const cacheStore = store as unknown as Store
    authorizedRootsCache.registerWorktreeRootsForRepo(cacheStore, 'repo-1', [
      '/workspace/feature-wt'
    ])
    authorizedRootsCache.registerWorktreeRootsForRepo(cacheStore, 'repo-2', ['/unrelated/worktree'])
    const removedRevision = authorizedRootsCache.getRegisteredWorktreeRootsRevision('repo-1')
    const unrelatedRevision = authorizedRootsCache.getRegisteredWorktreeRootsRevision('repo-2')

    await handlers['worktrees:remove'](null, { worktreeId: 'repo-1::/workspace/feature-wt' })

    expect(authorizedRootsCache.getRegisteredWorktreeRootsRevision('repo-1')).toBeGreaterThan(
      removedRevision
    )
    expect(authorizedRootsCache.getRegisteredWorktreeRootsRevision('repo-2')).toBe(
      unrelatedRevision
    )
    expect(authorizedRootsCache.isRegisteredWorktreePath('/workspace/feature-wt', cacheStore)).toBe(
      false
    )
    expect(authorizedRootsCache.isRegisteredWorktreePath('/unrelated/worktree', cacheStore)).toBe(
      true
    )

    expect(scopedRootsInvalidation.invalidateAuthorizedRootsCacheForRepo).toHaveBeenCalledOnce()
    expect(scopedRootsInvalidation.invalidateAuthorizedRootsCacheForRepo).toHaveBeenCalledWith(
      store,
      'repo-1'
    )
    expect(authorizedRootsCache.invalidateAuthorizedRootsCache).not.toHaveBeenCalled()

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

  it('globally invalidates when the removed repo has no registered authorization owner', async () => {
    mockKnownFeatureWorktree()
    store.getRepos.mockReturnValue([])
    getEffectiveHooksMock.mockReturnValue(null)
    removeWorktreeMock.mockResolvedValue({})

    await handlers['worktrees:remove'](null, { worktreeId: 'repo-1::/workspace/feature-wt' })

    expect(scopedRootsInvalidation.invalidateAuthorizedRootsCacheForRepo).toHaveBeenCalledOnce()
    expect(scopedRootsInvalidation.invalidateAuthorizedRootsCacheForRepo).toHaveBeenCalledWith(
      store,
      'repo-1'
    )
    expect(authorizedRootsCache.invalidateAuthorizedRootsCache).toHaveBeenCalledOnce()
  })

  it('purges only the selected host when a normal worktree id is owned locally and over SSH', async () => {
    const worktreeId = 'repo-1::/workspace/feature-wt'
    const localRepo = {
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'local',
      badgeColor: '#000',
      addedAt: 0
    }
    const sshRepo = {
      ...localRepo,
      displayName: 'ssh',
      connectionId: 'conn-1'
    }
    store.getRepos.mockReturnValue([localRepo, sshRepo])
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta({ hostId: 'local' }))
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue({})
    // Same-tab panes belong to different hosts; only the removed host may lose its pane.
    const localPane = makePaneKey('tab-shared', '11111111-1111-4111-8111-111111111111')
    const sshPane = makePaneKey('tab-shared', '22222222-2222-4222-8222-222222222222')
    const payload = { state: 'working', prompt: 'stranded', agentType: 'codex' } as const
    agentHookServer.ingestTerminalStatus({
      paneKey: localPane,
      tabId: 'tab-shared',
      worktreeId,
      connectionId: null,
      payload
    })
    agentHookServer.ingestRemote(
      { paneKey: sshPane, tabId: 'tab-shared', worktreeId, payload },
      'conn-1'
    )

    try {
      await handlers['worktrees:remove'](null, { worktreeId, hostId: 'local' })

      expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
        hostWorktreeTarget({ id: worktreeId, hostId: 'local' })
      )
      expect(advertisedUrlWatcherForgetWorktreeMock).not.toHaveBeenCalled()
      expect(deleteWorktreeHistoryDirMock).not.toHaveBeenCalled()
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
        repoId: 'repo-1'
      })
      expect(agentHookServer.getStatusSnapshot().map((row) => row.paneKey)).toEqual([sshPane])
    } finally {
      agentHookServer.dropStatusEntriesByTabPrefix('tab-shared')
    }
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
      // Parent spans make removal-stage freezes attributable.
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

    expect(scopedRootsInvalidation.invalidateAuthorizedRootsCacheForRepo).toHaveBeenCalledOnce()
    expect(scopedRootsInvalidation.invalidateAuthorizedRootsCacheForRepo).toHaveBeenCalledWith(
      store,
      'repo-1'
    )
    expect(authorizedRootsCache.invalidateAuthorizedRootsCache).not.toHaveBeenCalled()

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'prune'], {
      cwd: '/workspace/repo'
    })
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: 'repo-1::/workspace/feature-wt', hostId: 'local' })
    )
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith('repo-1::/workspace/feature-wt')
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: 'repo-1'
    })
  })

  it.each(['unproven', 'removal-fails'] as const)(
    'keeps desktop orphan cleanup retryable when the directory is %s',
    async (mode) => {
      const parentDir = await mkdtemp(join(tmpdir(), 'orca-ipc-orphan-retention-'))
      const repoPath = join(parentDir, 'repo')
      const orphanPath = join(parentDir, 'orphan')
      const worktreeId = `repo-1::${orphanPath}`
      await mkdir(orphanPath, { recursive: true })
      if (mode === 'removal-fails') {
        const adminPath = join(repoPath, '.git', 'worktrees', 'orphan')
        await mkdir(adminPath, { recursive: true })
        await writeFile(join(orphanPath, '.git'), `gitdir: ${adminPath}\n`)
        await writeFile(join(adminPath, 'gitdir'), `${join(orphanPath, '.git')}\n`)
      }
      const repo = { id: 'repo-1', path: repoPath, displayName: 'repo', badgeColor: '', addedAt: 0 }
      store.getRepos.mockReturnValue([repo])
      store.getRepo.mockReturnValue(repo)
      mockKnownFeatureWorktree(orphanPath, repoPath)
      getEffectiveHooksMock.mockReturnValue(null)
      removeWorktreeMock.mockRejectedValue(
        Object.assign(new Error('Git remove failed'), {
          stderr: `fatal: '${orphanPath}' is not a working tree`
        })
      )
      const finish = vi.fn().mockResolvedValue(undefined)
      runtimeStub.acquireFileWatcherRemoval.mockResolvedValue({ finish })
      const removePath = vi
        .spyOn(localWorktreeFilesystem, 'removeLocalWorktreePath')
        .mockRejectedValue(new Error('injected removal failure'))
      try {
        await expect(handlers['worktrees:remove'](null, { worktreeId })).rejects.toThrow(
          'Worktree is no longer registered with Git but its directory remains.'
        )
        await expect(lstat(orphanPath)).resolves.toBeTruthy()
        expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
        expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
          ['worktree', 'prune'],
          expect.anything()
        )
        expect(finish).toHaveBeenCalledWith(false)
        expect(removePath).toHaveBeenCalledTimes(mode === 'removal-fails' ? 1 : 0)
        await rm(orphanPath, { recursive: true, force: true })
        await expect(handlers['worktrees:remove'](null, { worktreeId })).resolves.toEqual({
          catalogVersion: anyCatalogVersion
        })
        expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
          hostWorktreeTarget({ id: worktreeId, hostId: 'local' })
        )
        expect(finish).toHaveBeenLastCalledWith(true)
      } finally {
        removePath.mockRestore()
        await rm(parentDir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(ORIGINAL_PLATFORM !== 'win32')(
    'force-deletes a real registered Windows long-path checkout through desktop Delete',
    async () => {
      const parentDir = await diskFs.realpath(await mkdtemp(join(tmpdir(), 'orca-ipc-long-path-')))
      const repoPath = join(parentDir, 'repo')
      const worktreePath = join(parentDir, 'feature-wt')
      const worktreeId = `repo-1::${worktreePath}`
      const git = async (args: string[]) =>
        (await promisify(execFile)('git', args, { cwd: repoPath })).stdout
      try {
        await mkdir(repoPath)
        await git(['init', '-q', '-b', 'main'])
        await git(['config', 'user.email', 'removal@example.invalid'])
        await git(['config', 'user.name', 'Worktree Removal'])
        await git(['config', 'maintenance.auto', 'false'])
        await git(['config', 'gc.auto', '0'])
        await git(['commit', '--allow-empty', '-qm', 'seed'])
        await git(['worktree', 'add', '-q', '-b', 'feature', worktreePath])
        const deep = join(worktreePath, ...Array.from({ length: 6 }, () => 'deep-'.repeat(10)))
        await mkdir(toHostFilesystemPath(deep), { recursive: true })
        await writeFile(toHostFilesystemPath(join(deep, 'scratch.txt')), 'delete me')
        expect(join(deep, 'scratch.txt').length).toBeGreaterThan(260)
        expect((await lstat(join(worktreePath, '.git'))).isFile()).toBe(true)
        const admin = (await diskFs.readFile(join(worktreePath, '.git'), 'utf8')).trim().slice(8)
        vi.mocked(gitRunner.gitExecFileAsync).mockImplementation(actualGitRunner.gitExecFileAsync)
        listWorktreesMock.mockImplementation((repo) => readTranslatedWorktreeGraph(repo))
        vi.mocked(removeWorktree).mockImplementation(removeNativeWorktree)
        store.getRepo.mockReturnValue({ ...harnessRepo, path: repoPath, worktreeBaseRef: null })
        store.getRepos.mockReturnValue([{ ...harnessRepo, path: repoPath }])
        store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta())
        store.removeWorktreeMeta.mockImplementation(() =>
          store.getWorktreeMeta.mockReturnValue(undefined)
        )
        expect(await readTranslatedWorktreeGraph(repoPath)).toHaveLength(2)
        const head = (await git(['rev-parse', 'feature'])).trim()

        const result = await handlers['worktrees:remove'](null, { worktreeId, force: true })

        expect(result).toEqual({ catalogVersion: anyCatalogVersion })
        await expect(lstat(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(lstat(admin)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await readTranslatedWorktreeGraph(repoPath)).toHaveLength(1)
        expect(await git(['branch', '--list', 'feature'])).toBe('')
        expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
          hostWorktreeTarget({ id: worktreeId, hostId: 'local' })
        )
        expect(store.getWorktreeMeta(worktreeId)).toBeUndefined()
        await expect(
          handlers['worktrees:forceDeletePreservedBranch'](null, {
            worktreeId,
            branchName: 'feature',
            expectedHead: head
          })
        ).rejects.toThrow('No preserved branch cleanup is pending')
      } finally {
        await removeTree(toHostFilesystemPath(parentDir))
      }
    }
  )

  it('cleans a prunable Git-file row before archive or checkout teardown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-prunable-ipc-'))
    const markerPath = join(root, '.git')
    await writeFile(markerPath, 'gitdir: /preserved/admin\n')
    const worktreeId = `repo-1::${markerPath}`
    const rows = mockKnownFeatureWorktree(markerPath).map((row) =>
      row.path === markerPath ? { ...row, branch: 'refs/heads/feature', prunable: true } : row
    )
    listWorktreesMock.mockResolvedValueOnce(rows).mockResolvedValue([])
    try {
      const result = await handlers['worktrees:remove'](null, { worktreeId })
      expect(result).toEqual({
        preservedBranch: { branchName: 'feature', head: 'feature' },
        catalogVersion: anyCatalogVersion
      })
      expect(runHookMock).not.toHaveBeenCalled()
      expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
      expect(removeWorktreeMock).not.toHaveBeenCalled()
      expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'prune'], {
        cwd: '/workspace/repo'
      })
      expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
        hostWorktreeTarget({ id: worktreeId, hostId: 'local' })
      )
      expect((await lstat(markerPath)).isFile()).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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
      onPtyStopped: clearProviderPtyStateMock,
      // Structured sessions are invisible to PTY inventories, so folder removal closes them separately.
      closeStructuredSessions: true
    })
    expect(killAllProcessesForWorktreeMock.mock.invocationCallOrder[0]).toBeLessThan(
      store.removeWorktreeMeta.mock.invocationCallOrder[0]
    )
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: worktreeId, hostId: 'local' })
    )
    expect(advertisedUrlWatcherForgetWorktreeMock).toHaveBeenCalledWith(worktreeId)
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: 'repo-folder'
    })
  })

  it('purges a folder workspace after a rejected best-effort PTY sweep', async () => {
    const worktreeId = 'repo-folder::/workspace/folder::workspace:child-1'
    store.getRepo.mockReturnValue({
      id: 'repo-folder',
      path: '/workspace/folder',
      displayName: 'folder',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'folder'
    })
    killAllProcessesForWorktreeMock.mockRejectedValue(new Error('terminal inventory unavailable'))

    await handlers['worktrees:remove'](null, { worktreeId })

    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: worktreeId, hostId: 'local' })
    )
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: 'repo-folder'
    })
    expect(store.removeWorktreeMeta.mock.invocationCallOrder[0]).toBeLessThan(
      mainWindow.webContents.send.mock.invocationCallOrder[0]
    )
  })

  // Folder workspace IDs repeat across hosts; fence teardown to the owning connection.
  it('fences an SSH folder workspace PTY sweep to the owning connection', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an identity marker; the mocked sweep never calls into it.
    const localPtyProvider = { id: 'local-pty-provider' } as never
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
    getLocalPtyProviderMock.mockReturnValue(localPtyProvider)
    // Same-ID local metadata must not override the resolved SSH repo owner.
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta({ hostId: 'local' }))

    await handlers['worktrees:remove'](null, { worktreeId })

    expect(killAllProcessesForWorktreeMock).toHaveBeenCalledWith(worktreeId, {
      runtime: runtimeStub,
      resolvedWorktreeId: worktreeId,
      resolvedConnectionId: 'conn-1',
      localProvider: localPtyProvider,
      onPtyStopped: clearProviderPtyStateMock,
      includeProviderInventory: false,
      includeLocalRegistry: false,
      closeStructuredSessions: true
    })
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:conn-1' })
    )
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
      includeLocalRegistry: false,
      closeStructuredSessions: true
    })
  })
  // Authoritative off-host removal must retire status rows too; local GC cannot reach them.
  it("retires the scan-proven host rows from the agent status store, and only that host's", async () => {
    const worktreeId = 'repo-1::/remote/deleted'
    store.getRepos.mockReturnValue([
      {
        id: 'repo-1',
        path: '/remote/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: 'target-a'
      }
    ])
    store.getProjectHostSetups.mockReturnValue([])
    store.getAllWorktreeMeta.mockReturnValue({
      [worktreeId]: makeWorktreeMeta({ hostId: 'ssh:target-a' })
    })
    const scannedPane = makePaneKey('tab-scan', '33333333-3333-4333-8333-333333333333')
    const otherHostPane = makePaneKey('tab-scan', '44444444-4444-4444-8444-444444444444')
    const payload = { state: 'working', prompt: 'stranded', agentType: 'codex' } as const
    agentHookServer.ingestRemote(
      { paneKey: scannedPane, tabId: 'tab-scan', worktreeId, payload },
      'target-a'
    )
    agentHookServer.ingestRemote(
      { paneKey: otherHostPane, tabId: 'tab-scan', worktreeId, payload },
      'target-b'
    )

    try {
      await handlers['worktrees:forgetRemovedForExecutionHost'](null, {
        repoId: 'repo-1',
        executionHostId: 'ssh:target-a',
        worktreeIds: [worktreeId]
      })

      expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
        hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:target-a' })
      )
      expect(agentHookServer.getStatusSnapshot().map((row) => row.paneKey)).toEqual([otherHostPane])
    } finally {
      agentHookServer.dropStatusEntriesByTabPrefix('tab-scan')
    }
  })
})
