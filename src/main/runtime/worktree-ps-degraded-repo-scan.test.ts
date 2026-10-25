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
vi.mock('electron', () => electronMocks)

const listWorktreesStrictMock = vi.hoisted(() => vi.fn())
vi.mock('../git/worktree', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorktreesStrict: listWorktreesStrictMock
}))

import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../shared/execution-host'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { WorktreeLineage } from '../../shared/worktree/lineage-types'
import { worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { OrcaRuntimeService } from './orca-runtime'
import {
  hostWorktreeTarget,
  type HostWorktreeTarget
} from '../../shared/worktree/host-qualified-identity'
import { partialRuntimeStore, storeRepo, storeWorktreeMeta } from './runtime-store-partial-fixture'

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

// Why: prune assertions only discriminate when the repo actually owns lineage rows a scan verdict could delete.
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

  // Why: `withTimeout` resolves its fallback on rejection as well as on timeout, so an unabsorbed rejection would silently widen
  // selector resolution for local repos the way a stall does.
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

  // Why: an authoritative empty scan must retain the normal backoff instead of spawning Git on every ~1s snapshot.
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

  // Why: one repo id can be registered on several execution hosts, so a stalled host must not republish another host's rows.
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

  // Why: the ownership gate must not cost the single-host case the fix exists for — a stamped row on its own host still comes back.
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
      // Why: no git answered, so a restored row must not claim a branch it cannot have verified.
      expect(restored?.branch).toBe('')
      // Why: `worktree.ps` summaries carry no head, so pin the blank head on the resolved row the restore path actually builds.
      const resolved = await advancePastRepoScanBudget(
        runtime.showManagedWorktree(`id:${WORKTREE_ID}`)
      )
      expect(resolved.head).toBe('')
      expect(resolved.git.head).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: the timeout fires per poll, so only the in-flight scan map keeps a permanent stall from re-spawning `git worktree list`.
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
    const runtime = new OrcaRuntimeService(partialRuntimeStore(store))

    await runtime.getWorktreePs(10_000)

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
