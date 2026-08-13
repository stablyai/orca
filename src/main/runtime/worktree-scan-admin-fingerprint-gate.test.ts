// The fingerprint's own behaviour is covered against real Git in repo-worktree-admin-fingerprint.test.ts.
// This suite pins the cache wiring: when the probe may skip a `git worktree list`, and when it may not.
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

const readRepoWorktreeAdminFingerprintMock = vi.hoisted(() => vi.fn())
vi.mock('./repo-worktree-admin-fingerprint', () => ({
  readRepoWorktreeAdminFingerprint: readRepoWorktreeAdminFingerprintMock
}))

import { OrcaRuntimeService, WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS } from './orca-runtime'

const REPO_ID = 'repo-local'
const REPO_PATH = '/Users/me/dev/app'
const WORKTREE_PATH = '/Users/me/dev/app-feature'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`
const MAIN_WORKTREE_ID = `${REPO_ID}::${REPO_PATH}`
const SCAN_TTL_MS = 30_000

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

function makeStore(options: { connectionId?: string; repoCount?: number; repoPath?: string } = {}) {
  const metaById: Record<string, ReturnType<typeof makeMeta>> = {
    [WORKTREE_ID]: makeMeta(),
    [MAIN_WORKTREE_ID]: makeMeta({ displayName: 'main' })
  }
  const basePath = options.repoPath ?? REPO_PATH
  const repos = Array.from({ length: options.repoCount ?? 1 }, (_unused, index) => ({
    id: index === 0 ? REPO_ID : `${REPO_ID}-${index}`,
    path: index === 0 ? basePath : `${basePath}-${index}`,
    displayName: 'app',
    badgeColor: 'blue',
    addedAt: 1,
    ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId })
  }))
  const store = {
    getRepo: (id: string) => store.getRepos().find((repo) => repo.id === id),
    getRepos: () => repos,
    getAllWorktreeMeta: () => metaById,
    getWorktreeMeta: (id: string) => metaById[id],
    setWorktreeMeta: (id: string, meta: Record<string, unknown>) => {
      metaById[id] = { ...(metaById[id] ?? makeMeta()), ...meta } as never
      return metaById[id]
    },
    removeWorktreeMeta: () => {},
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    removeWorktreeLineage: vi.fn(),
    removeWorkspaceLineage: vi.fn(),
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

type RuntimeInternals = { listResolvedWorktrees: () => Promise<unknown> }

function makeRuntime(
  options: { connectionId?: string; repoCount?: number; repoPath?: string } = {}
): {
  runtime: OrcaRuntimeService
  list: () => Promise<unknown>
} {
  const runtime = new OrcaRuntimeService(makeStore(options) as never)
  return {
    runtime,
    list: () => (runtime as unknown as RuntimeInternals).listResolvedWorktrees()
  }
}

function scanCount(): number {
  return listWorktreesStrictMock.mock.calls.length
}

describe('worktree scan admin-fingerprint gate', () => {
  beforeEach(() => {
    getSshGitProviderMock.mockReset()
    listWorktreesStrictMock.mockReset()
    listWorktreesStrictMock.mockResolvedValue([
      { path: REPO_PATH, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true },
      { path: WORKTREE_PATH, head: 'def', branch: 'feature', isBare: false, isMainWorktree: false }
    ])
    readRepoWorktreeAdminFingerprintMock.mockReset()
    readRepoWorktreeAdminFingerprintMock.mockResolvedValue('fp-1')
  })

  it('skips the Git scan past the TTL while the admin fingerprint is unchanged', async () => {
    vi.useFakeTimers()
    try {
      const { list } = makeRuntime()

      await list()
      expect(scanCount()).toBe(1)

      vi.advanceTimersByTime(SCAN_TTL_MS + 1_000)
      await list()
      expect(scanCount()).toBe(1)

      // The suppressed read must still re-arm the TTL rather than probing on every poll.
      vi.advanceTimersByTime(1_000)
      await list()
      expect(scanCount()).toBe(1)
      expect(readRepoWorktreeAdminFingerprintMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rescans at the TTL once the admin fingerprint changes', async () => {
    vi.useFakeTimers()
    try {
      const { list } = makeRuntime()

      await list()
      expect(scanCount()).toBe(1)

      readRepoWorktreeAdminFingerprintMock.mockResolvedValue('fp-2')
      vi.advanceTimersByTime(SCAN_TTL_MS + 1_000)
      await list()
      expect(scanCount()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconciles with a real scan once the bounded interval elapses', async () => {
    vi.useFakeTimers()
    try {
      const { list } = makeRuntime()

      await list()
      expect(scanCount()).toBe(1)

      // Keep polling past the TTL with an unchanged fingerprint; only the reconcile deadline rescans.
      for (
        let elapsed = 31_000;
        elapsed < WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS;
        elapsed += 31_000
      ) {
        vi.advanceTimersByTime(31_000)
        await list()
      }
      expect(scanCount()).toBe(1)

      vi.advanceTimersByTime(WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS)
      await list()
      expect(scanCount()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still rescans immediately when an event invalidates the repo', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, list } = makeRuntime()

      await list()
      expect(scanCount()).toBe(1)

      runtime.notifyBranchRenamed(REPO_ID)
      await list()
      expect(scanCount()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('scans when the probe cannot describe the repo', async () => {
    vi.useFakeTimers()
    try {
      readRepoWorktreeAdminFingerprintMock.mockResolvedValue(null)
      const { list } = makeRuntime()

      await list()
      vi.advanceTimersByTime(SCAN_TTL_MS + 1_000)
      await list()

      expect(scanCount()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never probes a repo whose scan TTL already reaches the reconcile interval', async () => {
    // Agent-scratch roots carry a 5-minute TTL, so a fingerprint could never be reused. Reading one
    // would be pure work on a polling path.
    vi.useFakeTimers()
    try {
      const { list } = makeRuntime({ repoPath: '/tmp/.codex-tmp/capsule-a' })

      await list()
      vi.advanceTimersByTime(WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS + 1_000)
      await list()

      expect(scanCount()).toBe(2)
      expect(readRepoWorktreeAdminFingerprintMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never consults the probe for SSH repos', async () => {
    vi.useFakeTimers()
    try {
      const listWorktrees = vi.fn(async () => [
        { path: REPO_PATH, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true }
      ])
      getSshGitProviderMock.mockReturnValue({ listWorktrees })
      const { list } = makeRuntime({ connectionId: 'ssh-remote-1' })

      await list()
      vi.advanceTimersByTime(SCAN_TTL_MS + 1_000)
      await list()

      expect(listWorktrees).toHaveBeenCalledTimes(2)
      expect(readRepoWorktreeAdminFingerprintMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not extend a failed scan on an unchanged fingerprint', async () => {
    vi.useFakeTimers()
    try {
      listWorktreesStrictMock.mockRejectedValue(new Error('git unavailable'))
      const { list } = makeRuntime()

      await list()
      expect(scanCount()).toBe(1)

      vi.advanceTimersByTime(SCAN_TTL_MS + 1_000)
      await list()
      expect(scanCount()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds Git fan-out under a sustained 1 Hz polling workload', async () => {
    // Reproduces the reported steady state: 10 idle repos, a caller polling faster than the
    // resolved-snapshot TTL. Before the gate this cost one `git worktree list` per repo per 30 s.
    vi.useFakeTimers()
    try {
      const REPOS = 10
      const POLL_SECONDS = 30 * 60
      const { list } = makeRuntime({ repoCount: REPOS })

      for (let second = 0; second < POLL_SECONDS; second += 1) {
        await list()
        vi.advanceTimersByTime(1_000)
      }

      // One scan per repo per cache refresh: the TTL alone would refresh 60x per repo, the
      // reconcile deadline refreshes 6x. 600 -> 60 `git worktree list` spawns per half hour.
      const ttlOnlyScans = (REPOS * POLL_SECONDS * 1_000) / SCAN_TTL_MS
      const reconcileScans =
        (REPOS * POLL_SECONDS * 1_000) / WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS
      expect(ttlOnlyScans).toBe(600)
      expect(reconcileScans).toBe(60)
      expect(scanCount()).toBe(reconcileScans)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shares one probe and one scan across concurrent callers', async () => {
    const { list } = makeRuntime()

    await Promise.all([list(), list(), list()])

    expect(scanCount()).toBe(1)
    expect(readRepoWorktreeAdminFingerprintMock).toHaveBeenCalledTimes(1)
  })
})
