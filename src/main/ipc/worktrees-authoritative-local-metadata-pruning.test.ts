import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type { NativeLocalWorktreeMetadataScanExpectation } from '../persistence/tracking-repos/missing-local-worktree-metadata-pruning'
import { notifyWorktreesChanged } from './worktree-remote'
import {
  listWorktreesMock,
  pruneCleanupScanSnapshotsMock,
  pruneSpaceAnalysisSnapshotsMock
} from './worktrees-test-module-mocks'
import { handlers, mainWindow, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { mockSelectedWslProjectRuntime } from './worktrees-test-fixtures'
import { pruneMetadataMissingFromAuthoritativeLocalScan } from './worktrees/listing/authoritative-local-worktree-metadata-pruning'
import { listDetectedWorktreesForCapturedRepo } from './worktrees/listing/detected-provider-listing'
import { getLocalWorktreeScanGeneration } from '../local-worktree-scan-generation'
import {
  isRegisteredWorktreePath,
  registerWorktreeRootsForRepo
} from './registered-worktree-roots-cache'

const localWorktreePathPresenceMock = vi.hoisted(() => vi.fn())

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
vi.mock('../local-worktree-path-presence', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  localWorktreePathsExistOrAreUnverifiable: localWorktreePathPresenceMock
}))
vi.mock('../runtime/worktree-teardown', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeTeardownModuleMock()
)
vi.mock('./pty', async () => (await import('./worktrees-test-module-mocks')).ptyModuleMock())

const REPO_ID = 'repo-1'
const REPO_PATH = '/workspace/repo'
const LOCAL_HOST_ID = 'local'

function worktree(path: string, overrides: Partial<GitWorktreeInfo> = {}): GitWorktreeInfo {
  return {
    path,
    head: path,
    branch: `refs/heads/${path.split('/').at(-1) ?? 'main'}`,
    isBare: false,
    isMainWorktree: path === REPO_PATH,
    ...overrides
  }
}

function scanExpectation(
  worktreeIds: readonly string[]
): NativeLocalWorktreeMetadataScanExpectation {
  const expectedRepo = {
    id: REPO_ID,
    path: REPO_PATH,
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0
  }
  return {
    repo: {
      id: REPO_ID,
      path: REPO_PATH,
      kind: 'git',
      expectedRepo
    },
    routing: {
      expectedProject: undefined,
      expectedProjectUpdatedAt: undefined,
      expectedSettings:
        {} as NativeLocalWorktreeMetadataScanExpectation['routing']['expectedSettings']
    },
    metadata: worktreeIds.map((worktreeId) => ({
      worktreeId,
      expectedLegacy: {
        expectedPresent: true,
        expectedMeta: undefined,
        expectedSerialized: undefined,
        expectedInstanceId: undefined,
        expectedHostId: LOCAL_HOST_ID
      },
      expectedAliases: []
    }))
  }
}

function listDetected(): Promise<unknown> {
  return handlers['worktrees:listDetected'](null, { repoId: REPO_ID }) as Promise<unknown>
}

const localListingCalls = [
  ['worktrees:listDetected', listDetected],
  [
    'worktrees:list',
    () => handlers['worktrees:list'](null, { repoId: REPO_ID }) as Promise<unknown>
  ],
  ['worktrees:listAll', () => handlers['worktrees:listAll'](null, undefined) as Promise<unknown>]
] as const

describe('authoritative local worktree metadata pruning integration', () => {
  beforeEach(() => {
    setupWorktreeHandlers()
    localWorktreePathPresenceMock.mockReset()
    localWorktreePathPresenceMock.mockImplementation(
      async (pathValues: readonly string[]) =>
        new Map(pathValues.map((pathValue) => [pathValue, false]))
    )
  })

  it('captures metadata expectations before starting the Git scan', async () => {
    const order: string[] = []
    store.captureNativeLocalWorktreeMetadataScanExpectation.mockImplementation(() => {
      order.push('capture')
      return scanExpectation([])
    })
    listWorktreesMock.mockImplementation(() => {
      order.push('scan')
      return Promise.resolve([worktree(REPO_PATH)])
    })

    await listDetected()

    expect(order).toEqual(['capture', 'scan'])
  })

  it('prunes once for the fresh producer, while coalesced and cached callers do nothing', async () => {
    const staleId = `${REPO_ID}::/workspace/stale`
    const rows = [worktree(REPO_PATH), worktree('/workspace/live')]
    store.captureNativeLocalWorktreeMetadataScanExpectation.mockReturnValue(
      scanExpectation([staleId])
    )
    store.pruneSessionlessMissingLocalWorktreeMetadataForRepo.mockReturnValue([staleId])
    listWorktreesMock.mockImplementation(async () => {
      await Promise.resolve()
      return rows
    })

    await Promise.all([listDetected(), listDetected(), listDetected()])
    await listDetected()

    expect(store.captureNativeLocalWorktreeMetadataScanExpectation).toHaveBeenCalledTimes(1)
    expect(store.pruneSessionlessMissingLocalWorktreeMetadataForRepo).toHaveBeenCalledTimes(1)
    const firstPruneCall = store.pruneSessionlessMissingLocalWorktreeMetadataForRepo.mock
      .calls[0] as [unknown, readonly { worktreeId: string }[]] | undefined
    expect(firstPruneCall?.[1].map(({ worktreeId }) => worktreeId)).toEqual([staleId])
    expect(pruneCleanupScanSnapshotsMock).toHaveBeenCalledTimes(1)
    expect(pruneCleanupScanSnapshotsMock).toHaveBeenCalledWith('/profile-a', [
      { worktreeId: staleId, executionHostId: LOCAL_HOST_ID }
    ])
    expect(pruneSpaceAnalysisSnapshotsMock).toHaveBeenCalledTimes(1)
    expect(pruneSpaceAnalysisSnapshotsMock).toHaveBeenCalledWith('/profile-a', [
      { worktreeId: staleId, executionHostId: LOCAL_HOST_ID }
    ])
  })

  it('does not prune when the authoritative scan is invalidated while in flight', async () => {
    const staleId = `${REPO_ID}::/workspace/stale`
    let resolveScan: (rows: GitWorktreeInfo[]) => void = () => {}
    store.captureNativeLocalWorktreeMetadataScanExpectation.mockReturnValue(
      scanExpectation([staleId])
    )
    store.pruneSessionlessMissingLocalWorktreeMetadataForRepo.mockReturnValue([staleId])
    listWorktreesMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve as (rows: GitWorktreeInfo[]) => void
        })
    )

    const pending = listDetected()
    await Promise.resolve()
    notifyWorktreesChanged(mainWindow as never, REPO_ID)
    resolveScan([worktree(REPO_PATH), worktree('/workspace/live')])
    await pending

    expect(store.captureNativeLocalWorktreeMetadataScanExpectation).toHaveBeenCalledTimes(1)
    expect(store.pruneSessionlessMissingLocalWorktreeMetadataForRepo).not.toHaveBeenCalled()
    expect(pruneCleanupScanSnapshotsMock).not.toHaveBeenCalled()
    expect(pruneSpaceAnalysisSnapshotsMock).not.toHaveBeenCalled()
  })

  it('does not prune when the completed scan is invalidated before its caller resumes', async () => {
    const staleId = `${REPO_ID}::/workspace/stale`
    let resolveScan: (rows: GitWorktreeInfo[]) => void = () => {}
    store.captureNativeLocalWorktreeMetadataScanExpectation.mockReturnValue(
      scanExpectation([staleId])
    )
    store.pruneSessionlessMissingLocalWorktreeMetadataForRepo.mockReturnValue([staleId])
    listWorktreesMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve as (rows: GitWorktreeInfo[]) => void
        })
    )

    const pending = listDetected()
    await Promise.resolve()
    resolveScan([worktree(REPO_PATH)])
    queueMicrotask(() => notifyWorktreesChanged(mainWindow as never, REPO_ID))
    await pending

    expect(store.pruneSessionlessMissingLocalWorktreeMetadataForRepo).not.toHaveBeenCalled()
  })

  it.each(localListingCalls)(
    'skips stale WSL root and lineage side effects after %s caller resumption',
    async (_channel, listWorktrees) => {
      const orphanId = `${REPO_ID}::/workspace/orphan`
      let resolveScan: (rows: GitWorktreeInfo[]) => void = () => {}
      mockSelectedWslProjectRuntime()
      store.getAllWorktreeLineage.mockReturnValue({
        [orphanId]: {
          worktreeId: orphanId,
          worktreeInstanceId: 'orphan-instance',
          parentWorktreeId: `${REPO_ID}::${REPO_PATH}`,
          parentWorktreeInstanceId: 'main-instance',
          origin: 'manual',
          capture: { source: 'manual-action', confidence: 'explicit' },
          createdAt: 0
        }
      })
      listWorktreesMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveScan = resolve as (rows: GitWorktreeInfo[]) => void
          })
      )

      const pending = listWorktrees()
      await Promise.resolve()
      resolveScan([worktree(REPO_PATH)])
      queueMicrotask(() => notifyWorktreesChanged(mainWindow as never, REPO_ID))
      await pending

      expect(store.removeWorktreeLineage).not.toHaveBeenCalled()
      expect(isRegisteredWorktreePath(REPO_PATH)).toBe(false)
    }
  )

  it('preserves WSL roots and lineage created while an older Git scan is pending', async () => {
    const newPath = '/workspace/new-wsl-worktree'
    const newId = `${REPO_ID}::${newPath}`
    let resolveScan: (rows: GitWorktreeInfo[]) => void = () => {}
    mockSelectedWslProjectRuntime()
    listWorktreesMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve as (rows: GitWorktreeInfo[]) => void
        })
    )

    const pending = listDetected()
    await Promise.resolve()

    resolveScan([worktree(REPO_PATH)])
    queueMicrotask(() => {
      registerWorktreeRootsForRepo(store as never, REPO_ID, [REPO_PATH, newPath])
      store.setWorktreeMeta(newId, { hostId: LOCAL_HOST_ID, instanceId: 'new-instance' })
      store.getAllWorktreeLineage.mockReturnValue({
        [newId]: {
          worktreeId: newId,
          worktreeInstanceId: 'new-instance',
          parentWorktreeId: `${REPO_ID}::${REPO_PATH}`,
          parentWorktreeInstanceId: 'main-instance',
          origin: 'manual',
          capture: { source: 'manual-action', confidence: 'explicit' },
          createdAt: 0
        }
      })
    })
    await pending

    expect(store.removeWorktreeLineage).not.toHaveBeenCalled()
    expect(isRegisteredWorktreePath(newPath)).toBe(true)
  })

  it.each(['scan generation', 'caller request'] as const)(
    'skips metadata, root, and lineage mutations when the %s is invalidated during path probes',
    async (invalidation) => {
      const staleId = `${REPO_ID}::/workspace/stale`
      const orphanId = `${REPO_ID}::/workspace/orphan`
      let callerCurrent = true
      let resolvePresence: (presence: ReadonlyMap<string, boolean>) => void = () => {}
      store.captureNativeLocalWorktreeMetadataScanExpectation.mockReturnValue(
        scanExpectation([staleId])
      )
      store.pruneSessionlessMissingLocalWorktreeMetadataForRepo.mockReturnValue([staleId])
      store.getAllWorktreeLineage.mockReturnValue({
        [orphanId]: {
          worktreeId: orphanId,
          worktreeInstanceId: 'orphan-instance',
          parentWorktreeId: `${REPO_ID}::${REPO_PATH}`,
          parentWorktreeInstanceId: 'main-instance',
          origin: 'manual',
          capture: { source: 'manual-action', confidence: 'explicit' },
          createdAt: 0
        }
      })
      localWorktreePathPresenceMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePresence = resolve
          })
      )
      listWorktreesMock.mockResolvedValue([worktree(REPO_PATH)])

      const pending = listDetectedWorktreesForCapturedRepo(
        store as never,
        store.getRepo(REPO_ID) as never,
        () => callerCurrent
      )
      await vi.waitFor(() => expect(localWorktreePathPresenceMock).toHaveBeenCalledTimes(1))
      if (invalidation === 'scan generation') {
        notifyWorktreesChanged(mainWindow as never, REPO_ID)
      } else {
        callerCurrent = false
      }
      resolvePresence(new Map([['/workspace/stale', false]]))
      await pending

      expect(store.pruneSessionlessMissingLocalWorktreeMetadataForRepo).not.toHaveBeenCalled()
      expect(store.removeWorktreeLineage).not.toHaveBeenCalled()
      expect(isRegisteredWorktreePath(REPO_PATH)).toBe(false)
      expect(pruneCleanupScanSnapshotsMock).not.toHaveBeenCalled()
      expect(pruneSpaceAnalysisSnapshotsMock).not.toHaveBeenCalled()
    }
  )

  it('preserves roots and lineage created while an older path probe is pending', async () => {
    const staleId = `${REPO_ID}::/workspace/stale`
    const newPath = '/workspace/new-worktree'
    const newId = `${REPO_ID}::${newPath}`
    let resolvePresence: (presence: ReadonlyMap<string, boolean>) => void = () => {}
    const metadata = new Map<string, { hostId: string; instanceId: string }>()
    store.getWorktreeMeta.mockImplementation((worktreeId) => metadata.get(worktreeId))
    store.captureNativeLocalWorktreeMetadataScanExpectation.mockReturnValue(
      scanExpectation([staleId])
    )
    store.pruneSessionlessMissingLocalWorktreeMetadataForRepo.mockReturnValue([staleId])
    localWorktreePathPresenceMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePresence = resolve
        })
    )
    listWorktreesMock.mockResolvedValue([worktree(REPO_PATH)])

    const pending = listDetected()
    await vi.waitFor(() => expect(localWorktreePathPresenceMock).toHaveBeenCalledTimes(1))

    registerWorktreeRootsForRepo(store as never, REPO_ID, [REPO_PATH, newPath])
    const newMetadata = { hostId: LOCAL_HOST_ID, instanceId: 'new-instance' }
    metadata.set(newId, newMetadata)
    store.setWorktreeMeta(newId, newMetadata)
    store.getAllWorktreeLineage.mockReturnValue({
      [newId]: {
        worktreeId: newId,
        worktreeInstanceId: newMetadata.instanceId,
        parentWorktreeId: `${REPO_ID}::${REPO_PATH}`,
        parentWorktreeInstanceId: 'main-instance',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 0
      }
    })
    resolvePresence(new Map([['/workspace/stale', false]]))
    await pending

    expect(store.pruneSessionlessMissingLocalWorktreeMetadataForRepo).toHaveBeenCalledTimes(1)
    expect(store.removeWorktreeLineage).not.toHaveBeenCalled()
    expect(isRegisteredWorktreePath(newPath)).toBe(true)
  })

  it('does not capture or prune on an initial WSL scan', async () => {
    mockSelectedWslProjectRuntime()
    listWorktreesMock.mockResolvedValue([worktree(REPO_PATH)])

    await listDetected()

    expect(listWorktreesMock).toHaveBeenCalledWith(REPO_PATH, { wslDistro: 'Ubuntu' })
    expect(store.captureNativeLocalWorktreeMetadataScanExpectation).not.toHaveBeenCalled()
    expect(store.pruneSessionlessMissingLocalWorktreeMetadataForRepo).not.toHaveBeenCalled()
  })

  it('does not let a native scan that changes to WSL routing become destructive', async () => {
    const staleId = `${REPO_ID}::/workspace/stale`
    const resolvers: ((rows: GitWorktreeInfo[]) => void)[] = []
    store.captureNativeLocalWorktreeMetadataScanExpectation.mockReturnValue(
      scanExpectation([staleId])
    )
    store.pruneSessionlessMissingLocalWorktreeMetadataForRepo.mockReturnValue([staleId])
    listWorktreesMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve as (rows: GitWorktreeInfo[]) => void)
        })
    )

    const nativePending = listDetected()
    await Promise.resolve()
    mockSelectedWslProjectRuntime()
    const wslPending = listDetected()
    await Promise.resolve()

    resolvers[1]?.([worktree(REPO_PATH)])
    await wslPending
    resolvers[0]?.([worktree(REPO_PATH), worktree('/workspace/live')])
    await nativePending

    expect(store.captureNativeLocalWorktreeMetadataScanExpectation).toHaveBeenCalledTimes(1)
    expect(store.pruneSessionlessMissingLocalWorktreeMetadataForRepo).not.toHaveBeenCalled()
    expect(pruneCleanupScanSnapshotsMock).not.toHaveBeenCalled()
    expect(pruneSpaceAnalysisSnapshotsMock).not.toHaveBeenCalled()
  })

  it.each([
    ['empty', [] as GitWorktreeInfo[]],
    ['failed', new Error('git worktree list failed')]
  ] as const)('does nothing for an %s authoritative scan', async (_label, result) => {
    const staleId = `${REPO_ID}::/workspace/stale`
    store.captureNativeLocalWorktreeMetadataScanExpectation.mockReturnValue(
      scanExpectation([staleId])
    )
    store.pruneSessionlessMissingLocalWorktreeMetadataForRepo.mockReturnValue([staleId])
    if (result instanceof Error) {
      listWorktreesMock.mockRejectedValue(result)
    } else {
      listWorktreesMock.mockResolvedValue(result)
    }

    await listDetected()

    expect(store.pruneSessionlessMissingLocalWorktreeMetadataForRepo).not.toHaveBeenCalled()
    expect(pruneCleanupScanSnapshotsMock).not.toHaveBeenCalled()
    expect(pruneSpaceAnalysisSnapshotsMock).not.toHaveBeenCalled()
  })

  it('keeps prunable Git registrations live and does not probe their paths', async () => {
    const staleId = `${REPO_ID}::/workspace/stale`
    const liveId = `${REPO_ID}::/workspace/live`
    const prunableId = `${REPO_ID}::/workspace/prunable`
    store.captureNativeLocalWorktreeMetadataScanExpectation.mockReturnValue(
      scanExpectation([staleId, liveId, prunableId])
    )
    store.pruneSessionlessMissingLocalWorktreeMetadataForRepo.mockReturnValue([staleId])
    listWorktreesMock.mockResolvedValue([
      worktree(REPO_PATH),
      worktree('/workspace/live'),
      worktree('/workspace/prunable', { prunable: true })
    ])

    await listDetected()

    expect(store.pruneSessionlessMissingLocalWorktreeMetadataForRepo).toHaveBeenCalledTimes(1)
    const missing = store.pruneSessionlessMissingLocalWorktreeMetadataForRepo.mock.calls[0]?.[1] as
      | readonly { worktreeId: string }[]
      | undefined
    expect(missing?.map(({ worktreeId }) => worktreeId)).toEqual([staleId])
    expect(missing?.map(({ worktreeId }) => worktreeId)).not.toContain(liveId)
    expect(missing?.map(({ worktreeId }) => worktreeId)).not.toContain(prunableId)
    expect(localWorktreePathPresenceMock).toHaveBeenCalledWith(['/workspace/stale'], {
      signal: undefined
    })
  })

  it('keeps the configured repo path live when Git reports a canonical spelling', async () => {
    const configuredMainId = `${REPO_ID}::${REPO_PATH}`
    const staleId = `${REPO_ID}::/workspace/stale`
    store.captureNativeLocalWorktreeMetadataScanExpectation.mockReturnValue(
      scanExpectation([configuredMainId, staleId])
    )
    store.pruneSessionlessMissingLocalWorktreeMetadataForRepo.mockReturnValue([staleId])
    listWorktreesMock.mockResolvedValue([worktree('/canonical/workspace/repo')])

    await listDetected()

    const missing = store.pruneSessionlessMissingLocalWorktreeMetadataForRepo.mock.calls[0]?.[1] as
      | readonly { worktreeId: string }[]
      | undefined
    expect(missing?.map(({ worktreeId }) => worktreeId)).toEqual([staleId])
    expect(missing?.map(({ worktreeId }) => worktreeId)).not.toContain(configuredMainId)
  })

  it('keeps a linked worktree whose persisted symlink spelling still exists', async () => {
    const aliasId = `${REPO_ID}::/workspace/alias/linked`
    const staleId = `${REPO_ID}::/workspace/stale`
    const scan = scanExpectation([aliasId, staleId])
    const repo = scan.repo.expectedRepo!
    const prune = vi.fn(
      (
        _scan: NativeLocalWorktreeMetadataScanExpectation,
        _missing: readonly { worktreeId: string }[]
      ) => [] as string[]
    )

    await pruneMetadataMissingFromAuthoritativeLocalScan({
      store: {
        getRepos: () => [repo],
        pruneSessionlessMissingLocalWorktreeMetadataForRepo: prune
      } as never,
      repo,
      gitWorktrees: [worktree('/workspace/real/linked')],
      scan,
      scanGeneration: getLocalWorktreeScanGeneration(REPO_ID),
      pathsExistOrAreUnverifiable: async (pathValues) =>
        new Map(pathValues.map((pathValue) => [pathValue, pathValue === '/workspace/alias/linked']))
    })

    expect(prune.mock.calls[0]?.[1].map(({ worktreeId }) => worktreeId)).toEqual([staleId])
  })

  it('does not rematerialize a removed lineage parent metadata row', async () => {
    const staleId = `${REPO_ID}::/workspace/stale`
    store.captureNativeLocalWorktreeMetadataScanExpectation.mockReturnValue(
      scanExpectation([staleId])
    )
    store.pruneSessionlessMissingLocalWorktreeMetadataForRepo.mockReturnValue([staleId])
    store.getAllWorktreeLineage.mockReturnValue({
      [`${REPO_ID}::/workspace/live-child`]: {
        worktreeId: `${REPO_ID}::/workspace/live-child`,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: staleId,
        parentWorktreeInstanceId: 'stale-instance',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 0
      }
    })
    listWorktreesMock.mockResolvedValue([worktree(REPO_PATH), worktree('/workspace/live')])

    await listDetected()

    expect(store.pruneSessionlessMissingLocalWorktreeMetadataForRepo).toHaveBeenCalledTimes(1)
    expect(store.setWorktreeMeta.mock.calls.some(([worktreeId]) => worktreeId === staleId)).toBe(
      false
    )
  })
})
