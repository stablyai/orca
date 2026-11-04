import type * as WorktreeScanCacheModule from '../git/worktrees/catalog/worktree-scan-cache'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
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
import { getLocalWorktreeScanGeneration } from '../workspaces/catalog/local-worktree-scan-generation'
import { agentHookServer } from '../agent-hooks/server'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  isRegisteredWorktreePath,
  registerWorktreeRootsForRepo
} from './worktrees/removal/registered-worktree-roots-cache'

const localWorktreePathPresenceMock = vi.hoisted(() => vi.fn())

// The WSL distros these fixtures route through count as running, so the boot gate lets Git run.
vi.mock('../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: (await import('./worktrees-test-module-mocks')).listWorktreesMock,
    listWorktreesSharedStrictAllowingTrueEmpty: (await import('./worktrees-test-module-mocks'))
      .listWorktreesMock,
    listWorktreesSharedStrict: (await import('./worktrees-test-module-mocks')).listWorktreesMock
  }
})

vi.mock('../wsl/discovery/wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readWslDistroRunningState: async () => 'running'
}))
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
vi.mock('../workspaces/catalog/local-worktree-path-presence', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  localWorktreePathsExistOrAreUnverifiable: localWorktreePathPresenceMock
}))
vi.mock('../runtime/worktree-teardown', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeTeardownModuleMock()
)
vi.mock('./pty/provider/registry', async () =>
  (await import('./worktrees-test-module-mocks')).ptyRegistryModuleMock()
)
vi.mock('./pty/provider/state-cleanup', async () =>
  (await import('./worktrees-test-module-mocks')).ptyStateCleanupModuleMock()
)

const REPO_ID = 'repo-1'
const REPO_PATH = '/workspace/repo'
const LOCAL_HOST_ID = 'local' as const

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

async function listDetected(): Promise<unknown> {
  return await handlers['worktrees:listDetected'](null, { repoId: REPO_ID })
}

describe('authoritative local worktree metadata pruning integration', () => {
  beforeEach(() => {
    setupWorktreeHandlers()
    localWorktreePathPresenceMock.mockReset()
    localWorktreePathPresenceMock.mockImplementation(
      async (pathValues: readonly string[]) =>
        new Map(pathValues.map((pathValue) => [pathValue, false]))
    )
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
    const stalePane = makePaneKey('tab-stale', '11111111-1111-4111-8111-111111111111')
    const livePane = makePaneKey('tab-live', '22222222-2222-4222-8222-222222222222')
    const working = {
      state: 'working',
      prompt: 'p',
      agentType: 'codex'
    } as const
    agentHookServer.ingestTerminalStatus({
      paneKey: stalePane,
      worktreeId: staleId,
      connectionId: null,
      payload: working
    })
    agentHookServer.ingestTerminalStatus({
      paneKey: livePane,
      worktreeId: `${REPO_ID}::/workspace/live`,
      connectionId: null,
      payload: working
    })

    await Promise.all([listDetected(), listDetected(), listDetected()])
    await listDetected()

    try {
      expect(agentHookServer.getStatusSnapshot().map((row) => row.paneKey)).toEqual([livePane])
    } finally {
      agentHookServer.dropStatusEntriesByTabPrefix('tab-stale')
      agentHookServer.dropStatusEntriesByTabPrefix('tab-live')
    }

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
    // The replacement scan restores the stale checkout; only the overtaken scan could prune it.
    await vi.waitFor(() => expect(listWorktreesMock).toHaveBeenCalledTimes(2))
    resolveScan([worktree(REPO_PATH), worktree('/workspace/live'), worktree('/workspace/stale')])
    await pending

    expect(store.captureNativeLocalWorktreeMetadataScanExpectation).toHaveBeenCalledTimes(2)
    expect(store.pruneSessionlessMissingLocalWorktreeMetadataForRepo).not.toHaveBeenCalled()
    expect(pruneCleanupScanSnapshotsMock).not.toHaveBeenCalled()
    expect(pruneSpaceAnalysisSnapshotsMock).not.toHaveBeenCalled()
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
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies the local repository rows read by this registry check.
      expect(isRegisteredWorktreePath(REPO_PATH, store as never)).toBe(false)
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
    store.setWorktreeMeta(hostWorktreeTarget({ id: newId, hostId: LOCAL_HOST_ID }), newMetadata)
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies the local repository rows read by this registry check.
    expect(isRegisteredWorktreePath(newPath, store as never)).toBe(true)
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
    // The WSL boot gate answers before the scan starts.
    await vi.waitFor(() => expect(listWorktreesMock).toHaveBeenCalledTimes(2))

    resolvers[1]?.([worktree(REPO_PATH)])
    await wslPending
    resolvers[0]?.([worktree(REPO_PATH), worktree('/workspace/live')])
    await nativePending

    expect(store.captureNativeLocalWorktreeMetadataScanExpectation).toHaveBeenCalledTimes(1)
    expect(store.pruneSessionlessMissingLocalWorktreeMetadataForRepo).not.toHaveBeenCalled()
    expect(pruneCleanupScanSnapshotsMock).not.toHaveBeenCalled()
    expect(pruneSpaceAnalysisSnapshotsMock).not.toHaveBeenCalled()
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
})
