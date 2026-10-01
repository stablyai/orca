// Pins the runtime scan wiring around its per-repo cache: invalidation, sharing, and scoped id
// resolution. Local freshness itself belongs to the worktree membership model (git/worktree-membership).
// Also listed in pr.yml's Windows boundary step, so the repo-path handling stays honest there.
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
  listWorktreesStrict: listWorktreesStrictMock,
  listWorktreesFromMembershipStrict: listWorktreesStrictMock
}))

import { OrcaRuntimeService } from './orca-runtime'
import { RESOLVED_WORKTREE_REPO_TIMEOUT_MS } from './repo-worktree-row-resolution'
import { canonicalWorktreeIdentity } from '../../shared/worktree/identity'

const REPO_ID = 'repo-local'
const REPO_PATH = '/Users/me/dev/app'
const WORKTREE_PATH = '/Users/me/dev/app-feature'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`
const MAIN_WORKTREE_ID = `${REPO_ID}::${REPO_PATH}`
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

describe('runtime worktree scan cache', () => {
  beforeEach(() => {
    getSshGitProviderMock.mockReset()
    listWorktreesStrictMock.mockReset()
    listWorktreesStrictMock.mockResolvedValue([
      { path: REPO_PATH, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true },
      { path: WORKTREE_PATH, head: 'def', branch: 'feature', isBare: false, isMainWorktree: false }
    ])
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

  it('shares one scan across concurrent callers', async () => {
    const { list } = makeRuntime()

    await Promise.all([list(), list(), list()])

    expect(scanCount()).toBe(1)
  })

  it('settles a fleet snapshot within one per-repo budget however many repos stall', async () => {
    vi.useFakeTimers()
    try {
      // A half-open SSH connection: every repo's listing hangs.
      getSshGitProviderMock.mockReturnValue({ listWorktrees: () => new Promise(() => {}) })
      const { list } = makeRuntime({ connectionId: 'remote-1', repoCount: 16 })
      let settled = false
      void list().then(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(RESOLVED_WORKTREE_REPO_TIMEOUT_MS + 100)
      expect(settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
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
