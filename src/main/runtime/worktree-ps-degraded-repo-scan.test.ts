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

const getSshGitProviderMock = vi.hoisted(() => vi.fn())
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  getSshGitProviderGeneration: vi.fn(() => 0),
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'unavailable',
  requireSshGitProvider: (connectionId: string) => getSshGitProviderMock(connectionId)
}))

const listWorktreesStrictMock = vi.hoisted(() => vi.fn())
vi.mock('../git/worktree', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorktreesStrict: listWorktreesStrictMock
}))

import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { OrcaRuntimeService } from './orca-runtime'

const REPO_ID = 'repo-remote'
const REPO_PATH = '/home/user/projects/app'
const WORKTREE_PATH = '/home/user/projects/app-feature'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`
const SCRATCH_ID = `${REPO_ID}::${REPO_PATH}/.claude/worktrees/scratch`
const SSH_CONNECTION_ID = 'ssh-remote-1'
const SSH_HOST_ID = `ssh:${SSH_CONNECTION_ID}`
const LOCAL_REPO_PATH = '/Users/me/dev/app'

function makeMeta(overrides: Record<string, unknown> = {}) {
  return {
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

const MAIN_WORKTREE_ID = `${REPO_ID}::${REPO_PATH}`

// Why: prune assertions only discriminate when the repo actually owns lineage rows a scan verdict could delete.
function makeLineage() {
  return {
    [WORKTREE_ID]: {
      worktreeId: WORKTREE_ID,
      worktreeInstanceId: 'child-instance',
      parentWorktreeId: MAIN_WORKTREE_ID,
      parentWorktreeInstanceId: 'parent-instance',
      origin: 'agent' as const,
      capture: 'env-workspace' as const,
      createdAt: 1
    }
  }
}

type StoreOptions = {
  connectionId?: string
  metaById?: Record<string, ReturnType<typeof makeMeta>>
  removeWorktreeLineage?: ReturnType<typeof vi.fn>
  removeWorkspaceLineage?: ReturnType<typeof vi.fn>
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
      {
        id: REPO_ID,
        path: REPO_PATH,
        displayName: 'app',
        badgeColor: 'blue',
        addedAt: 1,
        ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId })
      },
      ...(options.coHostedRepos ?? []).map((repo) => ({
        displayName: 'app',
        badgeColor: 'blue',
        addedAt: 1,
        ...repo
      }))
    ],
    getAllWorktreeMeta: vi.fn(() => metaById),
    getWorktreeMeta: (id: string) => metaById[id],
    setWorktreeMeta: (id: string, meta: Record<string, unknown>) => {
      metaById[id] = { ...(metaById[id] ?? makeMeta()), ...meta } as never
      return metaById[id]
    },
    removeWorktreeMeta: () => {},
    getAllWorktreeLineage: () => lineageById,
    getAllWorkspaceLineage: () => ({ [`worktree:${WORKTREE_ID}`]: { parentWorkspaceKey: null } }),
    removeWorktreeLineage: options.removeWorktreeLineage ?? vi.fn(),
    removeWorkspaceLineage: options.removeWorkspaceLineage ?? vi.fn(),
    getGitHubCache: () => undefined as never,
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

/** A healthy remote scan, so the only difference between the co-hosted cases is how `metaById` is stamped. */
function makeHealthySshScan() {
  return {
    listWorktrees: vi.fn(async () => [
      { path: REPO_PATH, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true },
      { path: WORKTREE_PATH, head: 'def', branch: 'feature', isBare: false, isMainWorktree: false }
    ])
  }
}

async function advancePastRepoScanBudget<T>(pending: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(6_000)
  return pending
}

describe('worktree.ps on a degraded repo scan', () => {
  beforeEach(() => {
    getSshGitProviderMock.mockReset()
    listWorktreesStrictMock.mockReset()
    listWorktreesStrictMock.mockResolvedValue([])
  })

  it('keeps persisted worktrees when a remote scan stalls past the per-repo budget', async () => {
    vi.useFakeTimers()
    try {
      getSshGitProviderMock.mockReturnValue({ listWorktrees: vi.fn(neverSettles) })
      const runtime = new OrcaRuntimeService(makeStore({ connectionId: 'ssh-remote-1' }) as never)

      const result = await advancePastRepoScanBudget(runtime.getWorktreePs(10_000))

      expect(result.worktrees.map((worktree) => worktree.worktreeId)).toContain(WORKTREE_ID)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps persisted worktrees when a remote repo is unreachable', async () => {
    getSshGitProviderMock.mockReturnValue(undefined)
    const runtime = new OrcaRuntimeService(makeStore({ connectionId: 'ssh-remote-1' }) as never)

    const result = await runtime.getWorktreePs(10_000)

    expect(result.worktrees.map((worktree) => worktree.worktreeId)).toContain(WORKTREE_ID)
  })

  it('keeps persisted worktrees when a local scan stalls past the per-repo budget', async () => {
    vi.useFakeTimers()
    try {
      listWorktreesStrictMock.mockImplementation(neverSettles)
      const runtime = new OrcaRuntimeService(makeStore() as never)

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
    const runtime = new OrcaRuntimeService(makeStore() as never)

    const result = await runtime.getWorktreePs(10_000)

    expect(result.worktrees.map((worktree) => worktree.worktreeId)).not.toContain(WORKTREE_ID)
  })

  it('still reports selector_not_found for a local worktree when the scan rejects', async () => {
    listWorktreesStrictMock.mockRejectedValue(new Error('git unavailable'))
    const runtime = new OrcaRuntimeService(makeStore() as never)

    await expect(runtime.showManagedWorktree(`id:${WORKTREE_ID}`)).rejects.toThrow(
      'selector_not_found'
    )
  })

  // Why: an authoritative empty scan must retain the normal backoff instead of spawning Git on every ~1s snapshot.
  it('caches a zero-row local scan instead of rescanning on every poll', async () => {
    vi.useFakeTimers()
    try {
      listWorktreesStrictMock.mockResolvedValue([])
      const runtime = new OrcaRuntimeService(makeStore() as never)

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
      const runtime = new OrcaRuntimeService(makeStore() as never)

      await runtime.getWorktreePs(10_000)
      await vi.advanceTimersByTimeAsync(2_000)
      await runtime.getWorktreePs(10_000)

      expect(listWorktreesStrictMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: remote disconnects should recover on the next poll; only local failures need backoff against spawn storms.
  it('rescans a degraded remote repo on the next poll instead of caching the failure', async () => {
    vi.useFakeTimers()
    try {
      const listWorktrees = vi.fn(async () => {
        throw new Error('provider offline')
      })
      getSshGitProviderMock.mockReturnValue({ listWorktrees })
      const runtime = new OrcaRuntimeService(
        makeStore({ connectionId: SSH_CONNECTION_ID }) as never
      )

      await runtime.getWorktreePs(10_000)
      await vi.advanceTimersByTimeAsync(2_000)
      await runtime.getWorktreePs(10_000)

      expect(listWorktrees).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: one repo id can be registered on several execution hosts, so a stalled host must not republish another host's rows.
  it('does not overwrite another execution host’s healthy rows when this host’s scan stalls', async () => {
    vi.useFakeTimers()
    try {
      getSshGitProviderMock.mockReturnValue(makeHealthySshScan())
      listWorktreesStrictMock.mockImplementation(neverSettles)
      const runtime = new OrcaRuntimeService(
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
        }) as never
      )

      const result = await advancePastRepoScanBudget(runtime.getWorktreePs(10_000))

      const remote = result.worktrees.find((worktree) => worktree.worktreeId === WORKTREE_ID)
      expect(remote?.branch).toBe('feature')
      expect(remote?.hostId).toBe(SSH_HOST_ID)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not claim an unstamped persisted row when the repo id is registered on two hosts', async () => {
    vi.useFakeTimers()
    try {
      getSshGitProviderMock.mockReturnValue(makeHealthySshScan())
      listWorktreesStrictMock.mockImplementation(neverSettles)
      const runtime = new OrcaRuntimeService(
        makeStore({
          connectionId: SSH_CONNECTION_ID,
          coHostedRepos: [{ id: REPO_ID, path: LOCAL_REPO_PATH }],
          metaById: {
            [WORKTREE_ID]: makeMeta(),
            [MAIN_WORKTREE_ID]: makeMeta({ displayName: 'main', instanceId: 'parent-instance' })
          }
        }) as never
      )

      const result = await advancePastRepoScanBudget(runtime.getWorktreePs(10_000))

      const remote = result.worktrees.find((worktree) => worktree.worktreeId === WORKTREE_ID)
      expect(remote?.hostId).toBe(SSH_HOST_ID)
      expect(remote?.branch).toBe('feature')
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
        makeStore({
          metaById: {
            [WORKTREE_ID]: makeMeta({ hostId: LOCAL_EXECUTION_HOST_ID }),
            [MAIN_WORKTREE_ID]: makeMeta({
              displayName: 'main',
              instanceId: 'parent-instance',
              hostId: LOCAL_EXECUTION_HOST_ID
            })
          }
        }) as never
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
      const runtime = new OrcaRuntimeService(makeStore() as never)

      await advancePastRepoScanBudget(runtime.getWorktreePs(10_000))
      await advancePastRepoScanBudget(runtime.getWorktreePs(10_000))

      expect(listWorktreesStrictMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops and prunes a worktree that a healthy scan no longer reports', async () => {
    const removeWorktreeLineage = vi.fn()
    const removeWorkspaceLineage = vi.fn()
    listWorktreesStrictMock.mockResolvedValue([
      { path: REPO_PATH, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true }
    ])
    const runtime = new OrcaRuntimeService(
      makeStore({ removeWorktreeLineage, removeWorkspaceLineage }) as never
    )

    const result = await runtime.getWorktreePs(10_000)

    expect(result.worktrees.map((worktree) => worktree.worktreeId)).not.toContain(WORKTREE_ID)
    expect(removeWorktreeLineage).toHaveBeenCalledWith(WORKTREE_ID)
    expect(removeWorkspaceLineage).toHaveBeenCalledWith(`worktree:${WORKTREE_ID}`)
  })

  it('does not prune lineage while a scan is stalled', async () => {
    vi.useFakeTimers()
    try {
      const removeWorktreeLineage = vi.fn()
      const removeWorkspaceLineage = vi.fn()
      listWorktreesStrictMock.mockImplementation(neverSettles)
      const runtime = new OrcaRuntimeService(
        makeStore({ removeWorktreeLineage, removeWorkspaceLineage }) as never
      )

      await advancePastRepoScanBudget(runtime.getWorktreePs(10_000))

      expect(removeWorktreeLineage).not.toHaveBeenCalled()
      expect(removeWorkspaceLineage).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not re-read persisted worktree metadata on a healthy scan', async () => {
    listWorktreesStrictMock.mockResolvedValue([
      { path: REPO_PATH, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true }
    ])
    const store = makeStore()
    const runtime = new OrcaRuntimeService(store as never)

    await runtime.getWorktreePs(10_000)

    expect(store.getAllWorktreeMeta).toHaveBeenCalledTimes(1)
  })

  it('lists restored worktrees while a scan is stalled and still hides agent scratch', async () => {
    vi.useFakeTimers()
    try {
      listWorktreesStrictMock.mockImplementation(neverSettles)
      const runtime = new OrcaRuntimeService(
        makeStore({
          metaById: {
            [WORKTREE_ID]: makeMeta(),
            [SCRATCH_ID]: makeMeta({ displayName: 'scratch' })
          }
        }) as never
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
