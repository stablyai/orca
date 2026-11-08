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

const listWorktreesStrictMock = vi.hoisted(() => vi.fn())

const readRepoWorktreeAdminFingerprintMock = vi.hoisted(() => vi.fn())
vi.mock('./repo-worktree-admin-fingerprint', () => ({
  readRepoWorktreeAdminFingerprint: readRepoWorktreeAdminFingerprintMock
}))

import { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS } from './worktree-scan-admin-budget'
import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'

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
    setWorktreeMeta: ({ id }: HostWorktreeTarget, meta: Record<string, unknown>) => {
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
    listWorktreesStrictMock.mockReset()
    listWorktreesStrictMock.mockResolvedValue([
      { path: REPO_PATH, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true },
      { path: WORKTREE_PATH, head: 'def', branch: 'feature', isBare: false, isMainWorktree: false }
    ])
    readRepoWorktreeAdminFingerprintMock.mockReset()
    readRepoWorktreeAdminFingerprintMock.mockResolvedValue('fp-1')
  })

  it('resolves a just-created id after invalidation even within both cache TTLs', async () => {
    const { runtime, list } = makeRuntime()
    listWorktreesStrictMock.mockResolvedValueOnce([
      { path: REPO_PATH, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true }
    ])
    await list()
    await expect(runtime.showManagedWorktree(`id:${WORKTREE_ID}`)).rejects.toThrow(
      'selector_not_found'
    )
    runtime.invalidateWorktreeCatalog(REPO_ID)
    await expect(runtime.showManagedWorktree(`id:${WORKTREE_ID}`)).resolves.toMatchObject({
      id: WORKTREE_ID
    })
    expect(scanCount()).toBe(2)
  })

  it('keeps refreshing when a probe on a wedged filesystem never settles', async () => {
    vi.useFakeTimers()
    try {
      stallProbeOnce()
      const { list } = makeRuntime()

      await list()
      expect(scanCount()).toBe(1)

      // Do not advance time: the refresh itself must avoid waiting on a dead probe.
      vi.advanceTimersByTime(SCAN_TTL_MS + 1_000)
      const second = list()
      const secondSettled = trackSettled(second)
      await drainMicrotasks()
      expect(secondSettled()).toBe(true)
      // #19312: a pending probe says nothing, so it reuses the scanned rows instead of rescanning.
      expect(heads(await second)).toEqual(['abc', 'def'])
      expect(scanCount()).toBe(1)

      vi.advanceTimersByTime(SCAN_TTL_MS + 1_000)
      const third = list()
      const thirdSettled = trackSettled(third)
      await drainMicrotasks()
      expect(thirdSettled()).toBe(true)
      await third
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

      // The probe must settle before caller fallback or each TTL expiry publishes persisted rows.
      await vi.advanceTimersByTimeAsync(WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS)
      await drainMicrotasks()
      expect(secondSettled()).toBe(true)
      expect(scanCount()).toBe(1)
      expect(heads(await second)).toEqual(['abc', 'def'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('scoped explicit worktree-id resolution', () => {
  beforeEach(() => {
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

  it('keeps cross-repo selectors on the fleet path so ambiguity still throws', async () => {
    const runtime = new OrcaRuntimeService(makeStore({ repoCount: 10 }) as never)
    const resolve = (selector: string): Promise<unknown> =>
      runtime['resolveGitWorktreeSelector'](selector)

    await expect(resolve('branch:main')).rejects.toThrow('selector_ambiguous')
    expect(new Set(scannedRepoPaths()).size).toBe(10)
  })
})
