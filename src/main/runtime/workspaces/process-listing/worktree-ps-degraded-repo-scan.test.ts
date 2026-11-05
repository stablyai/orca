import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => {
  const ipcMain = {
    on: vi.fn(() => ipcMain),
    removeListener: vi.fn(() => ipcMain),
    emit: vi.fn(() => true)
  }
  return {
    BrowserWindow: { fromId: vi.fn((): unknown => null) },
    webContents: { fromId: vi.fn((): unknown => null) },
    ipcMain,
    app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
  }
})
vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: listWorktreesStrictMock
  }
})

vi.mock('electron', () => electronMocks)
vi.mock('../catalog/repo-worktree-admin-fingerprint', () => ({
  readRepoWorktreeAdminFingerprint: vi.fn(async () => null)
}))

const listWorktreesStrictMock = vi.hoisted(() => vi.fn())

import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../../../shared/execution-host'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import { worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { OrcaRuntimeService } from '../../orca-runtime'
import {
  projectRepoWorktreeRows,
  scanRepoWorktreeRows
} from '../catalog/repo-worktree-row-resolution'
import type { Repo } from '../../../../shared/repo-types'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import type { RuntimeWorktreeScanResult } from '../catalog/repo-worktree-resolution-scan'
import * as removalTable from '../../../workspaces/removal/worktree-removal-table'
import {
  hostWorktreeTarget,
  type HostWorktreeTarget
} from '../../../../shared/worktree/host-qualified-identity'
import {
  partialRuntimeStore,
  storeRepo,
  storeWorktreeMeta
} from '../../orca-runtime-tests/runtime-store-partial-fixture'

const REPO_ID = 'repo-remote'
const REPO_PATH = '/home/user/projects/app'
const WORKTREE_PATH = '/home/user/projects/app-feature'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`
const SCRATCH_ID = `${REPO_ID}::${REPO_PATH}/.claude/worktrees/scratch`
const SSH_CONNECTION_ID = 'ssh-remote-1'
const SSH_HOST_ID = toSshExecutionHostId(SSH_CONNECTION_ID)
const LOCAL_REPO_PATH = '/Users/me/dev/app'

function makeMeta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return storeWorktreeMeta({
    displayName: 'feature',
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    ...overrides
  })
}

const MAIN_WORKTREE_ID = `${REPO_ID}::${REPO_PATH}`

// Seed real lineage rows so pruning assertions discriminate.
function makeLineage(): Record<string, WorktreeLineage> {
  return {
    [WORKTREE_ID]: {
      worktreeId: WORKTREE_ID,
      worktreeInstanceId: 'child-instance',
      parentWorktreeId: MAIN_WORKTREE_ID,
      parentWorktreeInstanceId: 'parent-instance',
      origin: 'cli',
      capture: { source: 'env-workspace', confidence: 'inferred' },
      createdAt: 1
    }
  }
}

type StoreOptions = {
  connectionId?: string
  metaById?: Record<string, WorktreeMeta>
  removeWorktreeLineage?: (target: HostWorktreeTarget) => void
  /** Extra `getRepos()` rows appended after the primary one, for same-id-on-two-hosts coverage. */
  coHostedRepos?: { id: string; path: string; connectionId?: string }[]
}

function makeStore(options: StoreOptions = {}) {
  const metaById = options.metaById ?? {
    [WORKTREE_ID]: makeMeta(),
    [MAIN_WORKTREE_ID]: makeMeta({ displayName: 'main', instanceId: 'parent-instance' })
  }
  const lineageById = makeLineage()
  const store = {
    getRepo: (id: string) => store.getRepos().find((repo) => repo.id === id),
    getRepos: () => [
      storeRepo({
        id: REPO_ID,
        path: REPO_PATH,
        displayName: 'app',
        badgeColor: 'blue',
        addedAt: 1,
        ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId })
      }),
      ...(options.coHostedRepos ?? []).map((repo) =>
        storeRepo({ displayName: 'app', badgeColor: 'blue', addedAt: 1, ...repo })
      )
    ],
    getAllWorktreeMeta: vi.fn(() => metaById),
    getWorktreeMeta: (id: string) => metaById[id],
    setWorktreeMeta: ({ id }: HostWorktreeTarget, meta: Partial<WorktreeMeta>) => {
      metaById[id] = { ...(metaById[id] ?? makeMeta()), ...meta }
      return metaById[id]
    },
    removeWorktreeMeta: () => {},
    getAllWorktreeLineage: () => lineageById,
    getAllWorkspaceLineage: () => ({
      [worktreeWorkspaceKey(WORKTREE_ID)]: {
        childWorkspaceKey: worktreeWorkspaceKey(WORKTREE_ID),
        childInstanceId: 'child-instance',
        parentWorkspaceKey: worktreeWorkspaceKey(MAIN_WORKTREE_ID),
        parentInstanceId: 'parent-instance',
        origin: 'cli' as const,
        capture: { source: 'env-workspace' as const, confidence: 'inferred' as const },
        createdAt: 1
      }
    }),
    removeWorktreeLineage: options.removeWorktreeLineage ?? vi.fn(),
    getSettings: () => ({
      workspaceDir: '/tmp/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    getProjects: () => []
  }
  return store
}

function neverSettles() {
  return new Promise<never>(() => {})
}

async function advancePastRepoScanBudget<T>(pending: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(6_000)
  return pending
}

class ScanCacheRuntime extends OrcaRuntimeService {
  protected override listRepoWorktreesForResolutionUncached =
    vi.fn<(repo: Repo) => Promise<RuntimeWorktreeScanResult>>()

  readonly scanGit = this.listRepoWorktreesForResolutionUncached

  async scanRows(
    repo: Repo,
    runtimes: ReadonlyMap<string, ProjectExecutionRuntimeResolution> = new Map()
  ) {
    const deps = this.repoWorktreeRowDeps()
    const scan = await scanRepoWorktreeRows(deps, repo, runtimes)
    return {
      ...scan,
      rows: projectRepoWorktreeRows(deps, repo, scan, deps.store.getAllWorktreeMeta())
    }
  }
}

function cachedScanFixture(connectionId: string | null = SSH_CONNECTION_ID) {
  const hostId = connectionId ? toSshExecutionHostId(connectionId) : LOCAL_EXECUTION_HOST_ID
  const store = makeStore({
    connectionId: connectionId ?? undefined,
    metaById: { [WORKTREE_ID]: makeMeta({ hostId, displayNameIsPinned: false }) }
  })
  const runtime = new ScanCacheRuntime(partialRuntimeStore(store))
  const repo = store.getRepos()[0]!
  const successfulScan: RuntimeWorktreeScanResult = {
    ok: true,
    worktrees: [
      {
        path: WORKTREE_PATH,
        head: 'abc',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: false
      }
    ]
  }
  return { runtime, repo, store, successfulScan }
}

describe('successful scan cache on timeout', () => {
  it.each([SSH_CONNECTION_ID, null])(
    'keeps automatic names and Git metadata from the last successful scan on %s',
    async (connectionId) => {
      vi.useFakeTimers()
      try {
        const { runtime, repo, successfulScan } = cachedScanFixture(connectionId)
        runtime.scanGit.mockResolvedValueOnce(successfulScan).mockImplementation(neverSettles)
        await runtime.scanRows(repo)
        await vi.advanceTimersByTimeAsync(31_000)

        const result = await advancePastRepoScanBudget(runtime.scanRows(repo))

        expect(result.ok).toBe(false)
        expect(result.rows).toEqual([
          expect.objectContaining({
            displayName: 'feature',
            branch: 'refs/heads/feature',
            head: 'abc',
            hostId: connectionId ? toSshExecutionHostId(connectionId) : LOCAL_EXECUTION_HOST_ID
          })
        ])
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it.each(['empty', 'failed', 'rejected'] as const)(
    'keeps completed %s scan semantics after a warm scan',
    async (verdict) => {
      vi.useFakeTimers()
      try {
        const { runtime, repo, successfulScan } = cachedScanFixture()
        runtime.scanGit.mockResolvedValueOnce(successfulScan)
        await runtime.scanRows(repo)
        await vi.advanceTimersByTimeAsync(31_000)
        if (verdict === 'rejected') {
          runtime.scanGit.mockRejectedValueOnce(new Error('offline'))
        } else {
          runtime.scanGit.mockResolvedValueOnce({ ok: verdict === 'empty', worktrees: [] })
        }

        const result = await runtime.scanRows(repo)

        expect(result.ok).toBe(verdict === 'empty')
        expect(result.rows).toEqual([])
        if (verdict === 'empty') {
          await vi.advanceTimersByTimeAsync(31_000)
          runtime.scanGit.mockImplementation(neverSettles)
          expect((await advancePastRepoScanBudget(runtime.scanRows(repo))).rows).toEqual([])
        }
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it.each(['generation', 'host', 'runtime'] as const)(
    'does not reuse a successful scan from another %s',
    async (owner) => {
      vi.useFakeTimers()
      try {
        const { runtime, repo, successfulScan } = cachedScanFixture(
          owner === 'runtime' ? null : SSH_CONNECTION_ID
        )
        // An explicit runtime snapshot can predate a settings change while Git is running.
        const runtimes = new Map<string, ProjectExecutionRuntimeResolution>(
          owner === 'runtime'
            ? [
                [
                  repo.id,
                  {
                    status: 'resolved',
                    runtime: {
                      kind: 'local-host',
                      hostPlatform: 'darwin',
                      projectId: 'old',
                      reason: 'non-windows',
                      cacheKey: 'old-runtime'
                    }
                  }
                ]
              ]
            : []
        )
        runtime.scanGit.mockResolvedValueOnce(successfulScan).mockImplementation(neverSettles)
        await runtime.scanRows(repo, runtimes)
        await vi.advanceTimersByTimeAsync(31_000)
        if (owner === 'generation') {
          runtime.invalidateWorktreeScanCacheForRepo(repo.id)
        }
        const current =
          owner === 'host'
            ? {
                ...repo,
                connectionId: 'another-host',
                executionHostId: toSshExecutionHostId('another-host')
              }
            : repo

        const result = await advancePastRepoScanBudget(runtime.scanRows(current))

        expect(result.ok).toBe(false)
        expect(result.rows).toHaveLength(owner === 'host' ? 0 : 1)
        expect(result.rows.every((row) => row.branch === '' && row.head === '')).toBe(true)
        if (owner !== 'host') {
          expect(result.rows[0]?.displayName).toBe('app')
        }
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('does not reuse failed cached local rows on timeout', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, repo, successfulScan } = cachedScanFixture(null)
      runtime.scanGit
        .mockResolvedValueOnce({ ...successfulScan, ok: false })
        .mockImplementation(neverSettles)
      await runtime.scanRows(repo)
      await vi.advanceTimersByTimeAsync(31_000)

      const result = await advancePastRepoScanBudget(runtime.scanRows(repo))

      expect(result.rows[0]).toMatchObject({ branch: '', head: '', displayName: 'app' })
      expect(result.ok).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a failed-removal checkout while the successful Git result awaits its listing overlay', async () => {
    vi.useFakeTimers()
    const checkoutExists = vi
      .spyOn(removalTable, 'worktreeCheckoutExists')
      .mockImplementation(neverSettles)
    removalTable.failedWorktreeRemovals.set(WORKTREE_ID, {
      worktreeId: WORKTREE_ID,
      repoId: REPO_ID,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      branch: 'feature',
      head: 'abc',
      deleteBranch: false,
      force: false,
      requestedAt: 1,
      failure: { message: 'checkout cleanup failed', failedAt: 2 }
    })
    try {
      const { runtime, repo } = cachedScanFixture(null)
      runtime.scanGit.mockResolvedValue({ ok: true, worktrees: [] })

      const result = await advancePastRepoScanBudget(runtime.scanRows(repo))

      expect(checkoutExists).toHaveBeenCalledWith(WORKTREE_PATH)
      expect(result.ok).toBe(false)
      expect(result.rows).toEqual([
        expect.objectContaining({ id: WORKTREE_ID, branch: '', head: '' })
      ])
    } finally {
      removalTable.failedWorktreeRemovals.delete(WORKTREE_ID)
      checkoutExists.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('worktree.ps on a degraded repo scan', () => {
  beforeEach(() => {
    listWorktreesStrictMock.mockReset()
    listWorktreesStrictMock.mockResolvedValue([])
  })

  it('keeps persisted worktrees when a remote scan stalls past the per-repo budget', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(
        partialRuntimeStore(makeStore({ connectionId: 'ssh-remote-1' }))
      )

      const result = await advancePastRepoScanBudget(runtime.getWorktreePs(10_000))

      expect(result.worktrees.map((worktree) => worktree.worktreeId)).toContain(WORKTREE_ID)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps persisted worktrees when a remote repo is unreachable', async () => {
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore(makeStore({ connectionId: 'ssh-remote-1' }))
    )

    const result = await runtime.getWorktreePs(10_000)

    expect(result.worktrees.map((worktree) => worktree.worktreeId)).toContain(WORKTREE_ID)
  })

  it('keeps persisted worktrees when a local scan stalls past the per-repo budget', async () => {
    vi.useFakeTimers()
    try {
      listWorktreesStrictMock.mockImplementation(neverSettles)
      const runtime = new OrcaRuntimeService(partialRuntimeStore(makeStore()))

      const result = await advancePastRepoScanBudget(runtime.getWorktreePs(10_000))

      expect(result.worktrees.map((worktree) => worktree.worktreeId)).toContain(WORKTREE_ID)
    } finally {
      vi.useRealTimers()
    }
  })

  // withTimeout also falls back on rejection; absorb real scan failures before they can restore stale rows.
  it('treats a rejected scan as a real answer instead of restoring persisted worktrees', async () => {
    listWorktreesStrictMock.mockRejectedValue(new Error('git unavailable'))
    const runtime = new OrcaRuntimeService(partialRuntimeStore(makeStore()))

    const result = await runtime.getWorktreePs(10_000)

    expect(result.worktrees.map((worktree) => worktree.worktreeId)).not.toContain(WORKTREE_ID)
  })

  it('still reports selector_not_found for a local worktree when the scan rejects', async () => {
    listWorktreesStrictMock.mockRejectedValue(new Error('git unavailable'))
    const runtime = new OrcaRuntimeService(partialRuntimeStore(makeStore()))

    await expect(runtime.showManagedWorktree(`id:${WORKTREE_ID}`)).rejects.toThrow(
      'selector_not_found'
    )
  })

  it('caches a zero-row local scan instead of rescanning on every poll', async () => {
    vi.useFakeTimers()
    try {
      listWorktreesStrictMock.mockResolvedValue([])
      const runtime = new OrcaRuntimeService(partialRuntimeStore(makeStore()))

      await runtime.getWorktreePs(10_000)
      await vi.advanceTimersByTimeAsync(2_000)
      await runtime.getWorktreePs(10_000)

      expect(listWorktreesStrictMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('caches a failed local scan instead of respawning Git on every poll', async () => {
    vi.useFakeTimers()
    try {
      listWorktreesStrictMock.mockRejectedValue(new Error('spawn git EAGAIN'))
      const runtime = new OrcaRuntimeService(partialRuntimeStore(makeStore()))

      await runtime.getWorktreePs(10_000)
      await vi.advanceTimersByTimeAsync(2_000)
      await runtime.getWorktreePs(10_000)

      expect(listWorktreesStrictMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not overwrite another execution host’s healthy rows when this host’s scan stalls', async () => {
    vi.useFakeTimers()
    try {
      listWorktreesStrictMock.mockImplementation(neverSettles)
      const runtime = new OrcaRuntimeService(
        partialRuntimeStore(
          makeStore({
            connectionId: SSH_CONNECTION_ID,
            coHostedRepos: [{ id: REPO_ID, path: LOCAL_REPO_PATH }],
            metaById: {
              [WORKTREE_ID]: makeMeta({ hostId: SSH_HOST_ID }),
              [MAIN_WORKTREE_ID]: makeMeta({
                displayName: 'main',
                instanceId: 'parent-instance',
                hostId: SSH_HOST_ID
              })
            }
          })
        )
      )

      const result = await advancePastRepoScanBudget(runtime.getWorktreePs(10_000))

      const remote = result.worktrees.find((worktree) => worktree.worktreeId === WORKTREE_ID)
      expect(remote?.hostId).toBe(SSH_HOST_ID)
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores persisted rows stamped for this host when its only owner stalls', async () => {
    vi.useFakeTimers()
    try {
      listWorktreesStrictMock.mockImplementation(neverSettles)
      const runtime = new OrcaRuntimeService(
        partialRuntimeStore(
          makeStore({
            metaById: {
              [WORKTREE_ID]: makeMeta({ hostId: LOCAL_EXECUTION_HOST_ID }),
              [MAIN_WORKTREE_ID]: makeMeta({
                displayName: 'main',
                instanceId: 'parent-instance',
                hostId: LOCAL_EXECUTION_HOST_ID
              })
            }
          })
        )
      )

      const result = await advancePastRepoScanBudget(runtime.getWorktreePs(10_000))

      const restored = result.worktrees.find((worktree) => worktree.worktreeId === WORKTREE_ID)
      expect(restored?.hostId).toBe(LOCAL_EXECUTION_HOST_ID)
      expect(restored?.branch).toBe('')
      // ps summaries omit head; inspect the resolved row to verify it too.
      const resolved = await advancePastRepoScanBudget(
        runtime.showManagedWorktree(`id:${WORKTREE_ID}`)
      )
      expect(resolved.head).toBe('')
      expect(resolved.git.head).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not re-spawn the git scan on every poll while a scan stays stalled', async () => {
    vi.useFakeTimers()
    try {
      listWorktreesStrictMock.mockImplementation(neverSettles)
      const runtime = new OrcaRuntimeService(partialRuntimeStore(makeStore()))

      await advancePastRepoScanBudget(runtime.getWorktreePs(10_000))
      await advancePastRepoScanBudget(runtime.getWorktreePs(10_000))

      expect(listWorktreesStrictMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops and prunes a worktree that a healthy scan no longer reports', async () => {
    const removeWorktreeLineage = vi.fn()
    listWorktreesStrictMock.mockResolvedValue([
      { path: REPO_PATH, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true }
    ])
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore(makeStore({ removeWorktreeLineage }))
    )

    const result = await runtime.getWorktreePs(10_000)

    expect(result.worktrees.map((worktree) => worktree.worktreeId)).not.toContain(WORKTREE_ID)
    expect(removeWorktreeLineage).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: WORKTREE_ID, hostId: 'local' })
    )
  })

  it('does not prune lineage while a scan is stalled', async () => {
    vi.useFakeTimers()
    try {
      const removeWorktreeLineage = vi.fn()
      listWorktreesStrictMock.mockImplementation(neverSettles)
      const runtime = new OrcaRuntimeService(
        partialRuntimeStore(makeStore({ removeWorktreeLineage }))
      )

      await advancePastRepoScanBudget(runtime.getWorktreePs(10_000))

      expect(removeWorktreeLineage).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not re-read persisted worktree metadata on a healthy scan', async () => {
    listWorktreesStrictMock.mockResolvedValue([
      { path: REPO_PATH, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true }
    ])
    const store = makeStore()
    const getWorktreeMetaForHost = vi.fn((id: string, hostId: string) =>
      hostId === 'local' ? store.getWorktreeMeta(id) : undefined
    )
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore({ ...store, getWorktreeMetaForHost })
    )

    await runtime.getWorktreePs(10_000)

    expect(getWorktreeMetaForHost).toHaveBeenCalledWith(MAIN_WORKTREE_ID, 'local')
    expect(store.getAllWorktreeMeta).toHaveBeenCalledTimes(1)
  })

  it('lists restored worktrees while a scan is stalled and still hides agent scratch', async () => {
    vi.useFakeTimers()
    try {
      listWorktreesStrictMock.mockImplementation(neverSettles)
      const runtime = new OrcaRuntimeService(
        partialRuntimeStore(
          makeStore({
            metaById: {
              [WORKTREE_ID]: makeMeta(),
              [SCRATCH_ID]: makeMeta({ displayName: 'scratch' })
            }
          })
        )
      )

      const listed = await advancePastRepoScanBudget(runtime.listManagedWorktrees(`id:${REPO_ID}`))

      const ids = listed.worktrees.map((worktree) => worktree.id)
      expect(ids).toContain(WORKTREE_ID)
      expect(ids).not.toContain(SCRATCH_ID)
    } finally {
      vi.useRealTimers()
    }
  })
})
