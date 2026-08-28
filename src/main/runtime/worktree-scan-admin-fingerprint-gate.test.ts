// The fingerprint's own behaviour is covered against real Git in repo-worktree-admin-fingerprint.test.ts.
// This suite pins the cache wiring: when the probe may skip a `git worktree list`, and when it may not.
// Also listed in pr.yml's Windows boundary step, so the gate's repo-path handling stays honest there.
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

import {
  OrcaRuntimeService,
  WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS,
  WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS
} from './orca-runtime'
import { RESOLVED_WORKTREE_REPO_TIMEOUT_MS } from './repo-worktree-row-resolution'
import { canonicalWorktreeIdentity } from '../../shared/worktree/identity'

const REPO_ID = 'repo-local'
const REPO_PATH = '/Users/me/dev/app'
const WORKTREE_PATH = '/Users/me/dev/app-feature'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`
const MAIN_WORKTREE_ID = `${REPO_ID}::${REPO_PATH}`
const SCAN_TTL_MS = 30_000
// A busy host (100+ linked worktrees, Defender, cold dentry cache, cloud placeholders) can spend
// seconds in pure stat time. Reuse has to survive that, or trimming the probe's deadline to fit the
// caller budget just trades a repeating stall for a repeating `git worktree list`.
const SLOW_BUT_HEALTHY_PROBE_MS = 3_000

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
    [WORKTREE_ID]: makeMeta({
      hostId: 'local',
      instanceId: '11111111-1111-4111-8111-111111111111'
    }),
    [MAIN_WORKTREE_ID]: makeMeta({
      displayName: 'main',
      hostId: 'local',
      instanceId: '22222222-2222-4222-8222-222222222222'
    })
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
  store: ReturnType<typeof makeStore>
} {
  const store = makeStore(options)
  const runtime = new OrcaRuntimeService(store as never)
  return {
    runtime,
    list: () => (runtime as unknown as RuntimeInternals).listResolvedWorktrees(),
    store
  }
}

function scanCount(): number {
  return listWorktreesStrictMock.mock.calls.length
}

/** Scanned rows carry the mocked tips; the persisted-row fallback publishes empty ones. */
function heads(worktrees: unknown): string[] {
  return (worktrees as { git: { head: string } }[]).map((worktree) => worktree.git.head).sort()
}

/** Let every already-settled promise chain run without advancing the clock, so a stall stays a stall. */
async function drainMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 200; tick += 1) {
    await Promise.resolve()
  }
}

function trackSettled(promise: Promise<unknown>): () => boolean {
  let settled = false
  void promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  return () => settled
}

function stallProbeOnce(): (fingerprint: string | null) => void {
  let release: (fingerprint: string | null) => void = () => {}
  readRepoWorktreeAdminFingerprintMock.mockReturnValueOnce(
    new Promise<string | null>((resolve) => {
      release = resolve
    })
  )
  return (fingerprint) => release(fingerprint)
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

  it('keeps refreshing when a probe on a wedged filesystem never settles', async () => {
    vi.useFakeTimers()
    try {
      stallProbeOnce()
      const { list } = makeRuntime()

      await list()
      expect(scanCount()).toBe(1)

      // No timer advance: the caller's 5s fallback cannot rescue this, so the refresh itself must
      // not be waiting on the dead probe.
      vi.advanceTimersByTime(SCAN_TTL_MS + 1_000)
      const second = list()
      const secondSettled = trackSettled(second)
      await drainMicrotasks()
      expect(secondSettled()).toBe(true)
      await second
      expect(scanCount()).toBe(2)

      vi.advanceTimersByTime(SCAN_TTL_MS + 1_000)
      const third = list()
      const thirdSettled = trackSettled(third)
      await drainMicrotasks()
      expect(thirdSettled()).toBe(true)
      await third
      expect(scanCount()).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('issues no further probes while one is still outstanding', async () => {
    vi.useFakeTimers()
    try {
      readRepoWorktreeAdminFingerprintMock.mockReturnValue(new Promise<string | null>(() => {}))
      const { list } = makeRuntime()

      await list()
      expect(readRepoWorktreeAdminFingerprintMock).toHaveBeenCalledTimes(1)

      for (let refresh = 0; refresh < 20; refresh += 1) {
        vi.advanceTimersByTime(SCAN_TTL_MS + 1_000)
        await list()
      }

      // Each abandoned probe pins an fs work item on the 4-slot libuv pool forever.
      expect(readRepoWorktreeAdminFingerprintMock).toHaveBeenCalledTimes(1)
      expect(scanCount()).toBe(21)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resumes gating once the filesystem recovers', async () => {
    vi.useFakeTimers()
    try {
      const releaseStalledProbe = stallProbeOnce()
      const { list } = makeRuntime()

      await list()
      vi.advanceTimersByTime(SCAN_TTL_MS + 1_000)
      await list()
      expect(scanCount()).toBe(2)

      // The mount unwedges; its stale answer must not gate anything, but the repo must probe again.
      releaseStalledProbe('fp-stale')
      await drainMicrotasks()
      vi.advanceTimersByTime(SCAN_TTL_MS + 1_000)
      await list()
      expect(scanCount()).toBe(3)

      vi.advanceTimersByTime(SCAN_TTL_MS + 1_000)
      await list()
      expect(scanCount()).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('scans when the awaited probe outlives its deadline', async () => {
    vi.useFakeTimers()
    try {
      const { list } = makeRuntime()

      await list()
      expect(scanCount()).toBe(1)

      stallProbeOnce()
      vi.advanceTimersByTime(SCAN_TTL_MS + 1_000)
      const second = list()
      const secondSettled = trackSettled(second)
      await drainMicrotasks()
      // A reusable cache entry is the one case that genuinely waits on the probe.
      expect(secondSettled()).toBe(false)
      expect(scanCount()).toBe(1)

      await vi.advanceTimersByTimeAsync(WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS)
      await drainMicrotasks()
      expect(scanCount()).toBe(2)
      await second
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds the awaited probe by the caller per-repo budget', () => {
    // The wait runs inside that budget, so outlasting it can only strand the caller on persisted rows.
    expect(WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS).toBeLessThan(
      RESOLVED_WORKTREE_REPO_TIMEOUT_MS
    )
  })

  it('still reuses the scan when a slow probe answers inside its deadline', async () => {
    vi.useFakeTimers()
    try {
      const { list } = makeRuntime()
      await list()
      expect(scanCount()).toBe(1)

      const releaseSlowProbe = stallProbeOnce()
      vi.advanceTimersByTime(SCAN_TTL_MS + 1_000)
      const second = list()

      // Deliberately an absolute figure, not one derived from the deadline: this is the lower end of
      // the band, and a self-referential advance would still pass however far the deadline is cut.
      await vi.advanceTimersByTimeAsync(SLOW_BUT_HEALTHY_PROBE_MS)
      releaseSlowProbe('fp-1')
      await second
      expect(scanCount()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still returns scanned rows within the per-repo budget when the probe stalls', async () => {
    vi.useFakeTimers()
    try {
      const { list } = makeRuntime()
      await list()

      stallProbeOnce()
      vi.advanceTimersByTime(SCAN_TTL_MS + 1_000)
      const second = list()
      const secondSettled = trackSettled(second)

      // The probe's own deadline has to end the wait; if the caller's fallback gets there first the
      // repo answers with persisted rows on every TTL expiry.
      await vi.advanceTimersByTimeAsync(WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS)
      await drainMicrotasks()
      expect(secondSettled()).toBe(true)
      expect(scanCount()).toBe(2)
      expect(heads(await second)).toEqual(['abc', 'def'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not publish an already-expired snapshot after a slow compute', async () => {
    vi.useFakeTimers()
    try {
      const { list, store } = makeRuntime()
      await list()

      stallProbeOnce()
      vi.advanceTimersByTime(SCAN_TTL_MS + 1_000)
      const second = list()
      await vi.advanceTimersByTimeAsync(WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS)
      await second

      // The probe deadline outlasts the snapshot TTL, so a start-stamped entry is born expired and
      // the next poll repeats the whole wait instead of reading the answer that just landed.
      const getRepos = vi.spyOn(store, 'getRepos')
      await list()
      expect(getRepos).not.toHaveBeenCalled()
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

describe('scoped explicit worktree-id resolution', () => {
  beforeEach(() => {
    getSshGitProviderMock.mockReset()
    listWorktreesStrictMock.mockReset()
    listWorktreesStrictMock.mockImplementation(async (repoPath: string) => [
      { path: repoPath, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true },
      {
        path: `${repoPath}-feature`,
        head: 'def',
        branch: 'feature',
        isBare: false,
        isMainWorktree: false
      }
    ])
    readRepoWorktreeAdminFingerprintMock.mockReset()
    readRepoWorktreeAdminFingerprintMock.mockResolvedValue('fp-1')
  })

  function scannedRepoPaths(): string[] {
    return listWorktreesStrictMock.mock.calls.map((call) => call[0] as string)
  }

  it('scans only the owning repo for an id: selector on a cold cache', async () => {
    const runtime = new OrcaRuntimeService(makeStore({ repoCount: 10 }) as never)
    const resolve = (selector: string): Promise<{ id: string }> =>
      (
        runtime as unknown as { resolveWorktreeSelector: (s: string) => Promise<{ id: string }> }
      ).resolveWorktreeSelector(selector)

    const resolved = await resolve(`id:${MAIN_WORKTREE_ID}`)

    expect(resolved.id).toBe(MAIN_WORKTREE_ID)
    expect(scannedRepoPaths()).toEqual([REPO_PATH])
  })
  it('resolves an exact canonical identity without relying on the mutable locator', async () => {
    const runtime = new OrcaRuntimeService(makeStore({ repoCount: 10 }) as never)
    const resolve = (selector: string): Promise<{ id: string }> =>
      (
        runtime as unknown as { resolveWorktreeSelector: (s: string) => Promise<{ id: string }> }
      ).resolveWorktreeSelector(selector)
    const identityKey = canonicalWorktreeIdentity({
      worktreeId: MAIN_WORKTREE_ID,
      executionHostId: 'local',
      instanceId: '22222222-2222-4222-8222-222222222222'
    })

    const resolved = await resolve(`identity:${identityKey}`)

    expect(resolved.id).toBe(MAIN_WORKTREE_ID)
  })

  it('still finds worktrees in other repos through the fleet path', async () => {
    const runtime = new OrcaRuntimeService(makeStore({ repoCount: 10 }) as never)
    const resolve = (selector: string): Promise<{ id: string }> =>
      (
        runtime as unknown as { resolveWorktreeSelector: (s: string) => Promise<{ id: string }> }
      ).resolveWorktreeSelector(selector)

    const otherId = `${REPO_ID}-3::${REPO_PATH}-3`
    const resolved = await resolve(`id:${otherId}`)

    expect(resolved.id).toBe(otherId)
    expect(scannedRepoPaths()).toEqual([`${REPO_PATH}-3`])
  })

  it('keeps cross-repo selectors on the fleet path so ambiguity still throws', async () => {
    const runtime = new OrcaRuntimeService(makeStore({ repoCount: 10 }) as never)
    const resolve = (selector: string): Promise<unknown> =>
      (
        runtime as unknown as { resolveWorktreeSelector: (s: string) => Promise<unknown> }
      ).resolveWorktreeSelector(selector)

    // `main` is checked out in every repo, so a branch selector must refuse rather than pick one.
    await expect(resolve('branch:main')).rejects.toThrow('selector_ambiguous')
    expect(new Set(scannedRepoPaths()).size).toBe(10)
  })

  it('falls back to the fleet path when the id names no registered repo', async () => {
    const runtime = new OrcaRuntimeService(makeStore({ repoCount: 10 }) as never)
    const resolve = (selector: string): Promise<unknown> =>
      (
        runtime as unknown as { resolveWorktreeSelector: (s: string) => Promise<unknown> }
      ).resolveWorktreeSelector(selector)

    await expect(resolve('id:missing-repo::/nowhere')).rejects.toThrow('selector_not_found')
    expect(new Set(scannedRepoPaths()).size).toBe(10)
  })
})
