import type * as WorktreeScanCacheModule from '../git/worktrees/catalog/worktree-scan-cache'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _resetWorktreeRemovalLifetimeForTests,
  worktreeRemovalLifetime
} from '../workspaces/removal/worktree-removal-lifetime'
import { prepareWorktreeRemovalsForStore } from '../workspaces/removal/worktree-removal-records-load'
import { readWorktreeRemovalRecords } from '../workspaces/removal/worktree-removal-records'
import {
  waitForWorktreeRemovalAcceptance,
  _resetPendingWorktreeRemovalsForTests
} from '../workspaces/removal/worktree-background-removal'
import { removeRuntimeRegisteredLocalWorktree } from '../runtime/workspaces/removal/runtime-registered-local-worktree-removal'
import type { RuntimeStore } from '../runtime/construction/runtime-store-contract'
import * as scopedRootsInvalidation from './worktrees/removal/registered-worktree-roots-scoped-invalidation'
import * as authorizedRootsCache from './worktrees/removal/registered-worktree-roots-cache'
import {
  removeWorktreeLinkedPathsMock,
  listWorktreesMock,
  assertWorktreeCleanForRemovalMock,
  removeWorktreeMock,
  getEffectiveHooksMock,
  runHookMock,
  killAllProcessesForWorktreeMock
} from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { mockKnownFeatureWorktree, mockSelectedWslProjectRuntime } from './worktrees-test-fixtures'

afterEach(() => {
  _resetWorktreeRemovalLifetimeForTests()
})

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
vi.mock('../git/remotes/repo-remote-queries', async () => ({
  getDefaultRemote: (await import('./worktrees-test-module-mocks')).getDefaultRemoteMock
}))
vi.mock('../git/refs/resolution/repo-branch-conflict', async () =>
  (await import('./worktrees-test-module-mocks')).gitBranchConflictModuleMock()
)

vi.mock('../git/refs/resolution/repo-default-base-ref', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultBaseRefAsync: (await import('./worktrees-test-module-mocks')).getBaseRefDefaultMock,
  resolveDefaultBaseRefWithLocalGit: (await import('./worktrees-test-module-mocks'))
    .resolveDefaultBaseRefWithLocalGitMock
}))
vi.mock('../git/repositories/git-username', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLocalGitUsername: (await import('./worktrees-test-module-mocks'))
    .resolveLocalGitUsernameMock
}))
vi.mock('../github/client/lookup/get-pr-for-branch', async () => ({
  getPRForBranch: (await import('./worktrees-test-module-mocks')).getPRForBranchMock
}))

vi.mock('../github/client/fetch/get-work-item', async () => {
  return {
    getWorkItem: (await import('./worktrees-test-module-mocks')).getWorkItemMock
  }
})

vi.mock('../github/client/lookup/pull-request-push-target', async () => {
  return {
    getPullRequestPushTarget: (await import('./worktrees-test-module-mocks'))
      .getPullRequestPushTargetMock
  }
})

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
    vi.spyOn(scopedRootsInvalidation, 'invalidateAuthorizedRootsCacheForRepo').mockClear()
    vi.spyOn(authorizedRootsCache, 'invalidateAuthorizedRootsCache').mockClear()
  })

  it('rechecks a local Git lock after the archive hook before teardown', async () => {
    const unlockedWorktrees = mockKnownFeatureWorktree()
    const lockedWorktrees = unlockedWorktrees.map((worktree) =>
      worktree.path === '/workspace/feature-wt'
        ? { ...worktree, locked: true, lockReason: 'locked during archive' }
        : worktree
    )
    listWorktreesMock
      .mockResolvedValueOnce(unlockedWorktrees)
      .mockResolvedValueOnce(lockedWorktrees)
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      symlinkPaths: ['node_modules']
    })
    getEffectiveHooksMock.mockReturnValue({ scripts: { archive: 'echo archived' } })
    runHookMock.mockResolvedValue({ success: true, output: '' })

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-1::/workspace/feature-wt',
        force: true
      })
    ).rejects.toThrow('Worktree is locked by Git')

    expect(runHookMock).toHaveBeenCalled()
    expect(removeWorktreeLinkedPathsMock).not.toHaveBeenCalled()
    expect(assertWorktreeCleanForRemovalMock).not.toHaveBeenCalled()
    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
  })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it.each(['ipc', 'runtime'] as const)(
  '%s refuses after a held preflight loses to committed shutdown, before stopping terminals',
  async (entry) => {
    const runtime = setupWorktreeHandlers()
    const acquireWatcherRemoval = vi.fn(async (_path: string) => ({
      finish: async (_removed: boolean) => {}
    }))
    runtime.acquireFileWatcherRemoval = acquireWatcherRemoval
    const rows = mockKnownFeatureWorktree()
    const entered = deferred()
    const preflight = deferred()
    assertWorktreeCleanForRemovalMock.mockImplementation(async () => {
      entered.resolve()
      await preflight.promise
    })
    const invoke = () =>
      entry === 'ipc'
        ? Promise.resolve(
            handlers['worktrees:remove'](null, { worktreeId: 'repo-1::/workspace/feature-wt' })
          )
        : removeRuntimeRegisteredLocalWorktree({
            repo: {
              id: 'repo-1',
              path: '/workspace/repo',
              displayName: 'repo',
              badgeColor: '',
              addedAt: 0
            },
            target: {
              id: 'repo-1::/workspace/feature-wt',
              repoId: 'repo-1',
              path: '/workspace/feature-wt'
            },
            registeredWorktree: rows[1],
            removedPushTarget: undefined,
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this path refuses before consuming store mutations.
            store: store as unknown as RuntimeStore,
            localOptions: {},
            hasLocalOptions: false,
            force: false,
            runHooks: false,
            allowFailedArchiveHook: false,
            allowUnverifiedPtyStop: false,
            deleteBranch: true,
            acquireWatcherRemoval,
            stopPtys: async () => {
              await killAllProcessesForWorktreeMock()
            },
            closeWatchers: async () => {},
            preserveBranchHead: (result) => result ?? {},
            finishRemoval: () => {},
            onRemoved: () => {},
            publish: () => {}
          })
    const request = invoke()
    const refused = expect(request).rejects.toThrow('Orca is stopping')
    await entered.promise
    await worktreeRemovalLifetime.close()
    preflight.resolve()
    await refused
    expect(runtime.acquireFileWatcherRemoval).not.toHaveBeenCalled()
    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
    expect(removeWorktreeLinkedPathsMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
  }
)

it.each(['ipc', 'runtime'] as const)(
  '%s finishes actual admission when teardown owned preparation before shutdown',
  async (entry) => {
    const runtime = setupWorktreeHandlers()
    const acquireWatcherRemoval = vi.fn(async (_path: string) => ({
      finish: async (_removed: boolean) => {}
    }))
    runtime.acquireFileWatcherRemoval = acquireWatcherRemoval
    const rows = mockKnownFeatureWorktree()
    const directory = await mkdtemp(join(tmpdir(), 'orca-removal-boundary-'))
    await prepareWorktreeRemovalsForStore({
      getProfileStorageDirectory: () => directory,
      getRepos: () => [{ id: 'repo-1' }]
    })
    const entered = deferred()
    const stopped = deferred()
    killAllProcessesForWorktreeMock.mockImplementation(async () => {
      entered.resolve()
      await stopped.promise
      return { runtimeStopped: 1, providerStopped: 0, registryStopped: 0 }
    })
    try {
      const request =
        entry === 'ipc'
          ? Promise.resolve(
              handlers['worktrees:remove'](null, { worktreeId: 'repo-1::/workspace/feature-wt' })
            )
          : removeRuntimeRegisteredLocalWorktree({
              repo: {
                id: 'repo-1',
                path: '/workspace/repo',
                displayName: 'repo',
                badgeColor: '',
                addedAt: 0
              },
              target: {
                id: 'repo-1::/workspace/feature-wt',
                repoId: 'repo-1',
                path: '/workspace/feature-wt'
              },
              registeredWorktree: rows[1],
              removedPushTarget: undefined,
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: cleanup is aborted before store mutations; admission uses the real journal.
              store: store as unknown as RuntimeStore,
              localOptions: {},
              hasLocalOptions: false,
              force: false,
              runHooks: false,
              allowFailedArchiveHook: false,
              allowUnverifiedPtyStop: false,
              deleteBranch: true,
              acquireWatcherRemoval,
              stopPtys: async () => {
                await killAllProcessesForWorktreeMock()
              },
              closeWatchers: async () => {},
              preserveBranchHead: (result) => result ?? {},
              finishRemoval: () => {},
              onRemoved: () => {},
              publish: () => {}
            })
      await entered.promise
      const closing = worktreeRemovalLifetime.close()
      stopped.resolve()
      if (entry === 'ipc') {
        void request.catch(() => {})
        await waitForWorktreeRemovalAcceptance('repo-1::/workspace/feature-wt')
      } else {
        await expect(request).resolves.toMatchObject({ removing: true })
      }
      await closing
      expect(removeWorktreeMock).not.toHaveBeenCalled()
      expect(await readWorktreeRemovalRecords(directory)).toEqual([
        expect.objectContaining({
          worktreeId: 'repo-1::/workspace/feature-wt',
          deleteBranch: true,
          force: false
        })
      ])
    } finally {
      _resetPendingWorktreeRemovalsForTests()
      await rm(directory, { recursive: true, force: true })
    }
  }
)

it.each([
  ['ipc', 'before-delete'],
  ['ipc', 'after-delete'],
  ['ipc', 'partial-delete'],
  ['runtime', 'before-delete'],
  ['runtime', 'after-delete'],
  ['runtime', 'partial-delete']
] as const)(
  '%s synchronous WSL owner preserves its result and metadata at %s',
  async (entry, phase) => {
    const runtime = setupWorktreeHandlers()
    mockSelectedWslProjectRuntime()
    const rows = mockKnownFeatureWorktree()
    const finish = vi.fn(async () => {})
    const gate = { finish: vi.fn(async () => {}) }
    const acquireWatcherRemoval = vi.fn(async (_path: string) => gate)
    runtime.acquireFileWatcherRemoval = acquireWatcherRemoval
    const signal = worktreeRemovalLifetime.signal
    removeWorktreeMock.mockImplementation(async (_repo, _path, _force, options) => {
      expect(options).toMatchObject({ checkoutDeleteSignal: signal })
      worktreeRemovalLifetime.abortCleanup()
      if (phase !== 'after-delete') {
        if (phase === 'partial-delete') {
          listWorktreesMock.mockResolvedValue([rows[0]])
        }
        throw signal.reason
      }
      return {}
    })
    const result =
      entry === 'ipc'
        ? Promise.resolve(
            handlers['worktrees:remove'](null, {
              worktreeId: 'repo-1::/workspace/feature-wt',
              deleteBranch: false
            })
          )
        : removeRuntimeRegisteredLocalWorktree({
            repo: {
              id: 'repo-1',
              path: '/workspace/repo',
              displayName: 'repo',
              badgeColor: '',
              addedAt: 0
            },
            target: {
              id: 'repo-1::/workspace/feature-wt',
              repoId: 'repo-1',
              path: '/workspace/feature-wt'
            },
            registeredWorktree: rows[1],
            removedPushTarget: undefined,
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the existing store fixture owns all metadata consumed by this real removal boundary.
            store: store as unknown as RuntimeStore,
            localOptions: { wslDistro: 'Ubuntu' },
            hasLocalOptions: true,
            force: false,
            runHooks: false,
            allowFailedArchiveHook: false,
            allowUnverifiedPtyStop: false,
            deleteBranch: false,
            acquireWatcherRemoval,
            stopPtys: async () => {},
            closeWatchers: async () => {},
            preserveBranchHead: (value) => value ?? {},
            finishRemoval: finish,
            onRemoved: () => {},
            publish: () => {}
          })
    if (phase === 'after-delete') {
      await expect(result).resolves.toMatchObject({})
      if (entry === 'runtime') {
        expect(finish).toHaveBeenCalledOnce()
      } else {
        expect(store.removeWorktreeMeta).toHaveBeenCalled()
      }
      expect(gate.finish).toHaveBeenCalledWith(true)
    } else {
      await expect(result).rejects.toThrow()
      expect(finish).not.toHaveBeenCalled()
      expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
      expect(gate.finish).toHaveBeenCalledWith(false)
    }
    expect(removeWorktreeMock).toHaveBeenCalledOnce()
  }
)
