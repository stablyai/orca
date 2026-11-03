import type * as WorktreeScanCacheModule from '../git/worktree-scan-cache'
import type * as WorktreeListingModule from '../git/worktree-listing'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type * as GitUsernameModule from '../git/git-username'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('../git/worktree-scan-cache', async (importOriginal) => {
  const facade = await vi.importMock<typeof WorktreeScanCacheModule>('../git/worktree')
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: facade.listWorktrees
  }
})

vi.mock('../git/worktree-listing', async (importOriginal) => {
  const facade = await vi.importMock<typeof WorktreeListingModule>('../git/worktree')
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: facade.listWorktreesStrict
  }
})

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

vi.mock('../workspace-hooks/hooks', () => ({
  getEffectiveHooks: vi.fn().mockReturnValue(null),
  runHook: vi.fn().mockResolvedValue({ success: true, output: '' })
}))
vi.mock('../workspace-hooks/worktree-runner-script', () => ({ createSetupRunnerScript: vi.fn() }))

vi.mock('../ipc/worktree-logic', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, computeWorktreePath: vi.fn(), ensurePathWithinWorkspace: vi.fn() }
})

vi.mock('../ipc/worktrees/removal/registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: vi.fn(),
  invalidateAuthorizedRootsCacheForRepo: vi.fn()
}))

vi.mock('../git/repo', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getDefaultBaseRef: vi.fn().mockReturnValue('origin/main'),
    getBranchConflictKind: vi.fn().mockResolvedValue(null)
  }
})

vi.mock('../git/git-username', async () => {
  const actual = await vi.importActual<typeof GitUsernameModule>('../git/git-username')
  return { ...actual, resolveLocalGitUsername: vi.fn(async () => '') }
})

const store = {
  getRepo: () => ({
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }),
  getRepos: () => [store.getRepo()],
  addRepo: () => {},
  updateRepo: () => undefined as never,
  getAllWorktreeMeta: () => ({}),
  getWorktreeMeta: () => undefined,
  getGitHubCache: () => ({ pr: {}, issue: {} }),
  setWorktreeMeta: () => undefined as never,
  removeWorktreeMeta: () => {},
  getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
  addRetiredWorktreeName: () => {},
  mergeRetiredWorktreeNames: () => false,
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: '',
    mobileAutoRestoreFitMs: null
  }),
  updateSettings: () => {}
}

type SessionTabsPrivate = {
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  touchMobileSessionSnapshotsForPty: (ptyId: string) => void
  notifyMobileSessionTabsChanged: (worktreeId?: string) => void
}

function seedPtyBackedSnapshot(runtime: OrcaRuntimeService, ptyId: string): void {
  const priv = runtime as unknown as SessionTabsPrivate
  priv.mobileSessionTabsByWorktree.set('worktree-a', {
    worktree: 'worktree-a',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: 'tab-1',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'tab-1',
        title: 'agent',
        parentTabId: 'group-1',
        leafId: 'leaf-1',
        ptyId,
        isActive: true
      }
    ]
  })
}

describe('session.tabs title/status churn coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('collapses a rapid title-flip burst into a single emit (repro)', () => {
    const runtime = new OrcaRuntimeService(store)
    seedPtyBackedSnapshot(runtime, 'pty-1')
    const priv = runtime as unknown as SessionTabsPrivate

    const emits: number[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
      emits.push(snapshot.snapshotVersion)
    })

    // Simulate a title spinner emitting 20 updates per second.
    const FLIPS = 20
    for (let i = 0; i < FLIPS; i++) {
      priv.touchMobileSessionSnapshotsForPty('pty-1')
      vi.advanceTimersByTime(10)
    }
    expect(emits).toHaveLength(0)

    vi.advanceTimersByTime(50)

    expect(emits).toHaveLength(1)
    const stored = priv.mobileSessionTabsByWorktree.get('worktree-a')
    expect(emits[0]).toBe(stored?.snapshotVersion)
    expect(emits[0]).toBe(1 + FLIPS)

    unsubscribe()
  })

  it('lets a structural change emit immediately and supersede the coalesced notify', () => {
    const runtime = new OrcaRuntimeService(store)
    seedPtyBackedSnapshot(runtime, 'pty-1')
    const priv = runtime as unknown as SessionTabsPrivate

    const emits: number[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
      emits.push(snapshot.snapshotVersion)
    })

    priv.touchMobileSessionSnapshotsForPty('pty-1')
    priv.notifyMobileSessionTabsChanged('worktree-a')
    expect(emits).toHaveLength(1)

    vi.advanceTimersByTime(50)
    expect(emits).toHaveLength(1)

    unsubscribe()
  })

  it('flushes a pending notify when the last subscriber closes', () => {
    const runtime = new OrcaRuntimeService(store)
    seedPtyBackedSnapshot(runtime, 'pty-1')
    const priv = runtime as unknown as SessionTabsPrivate

    const emits: number[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
      emits.push(snapshot.snapshotVersion)
    })

    priv.touchMobileSessionSnapshotsForPty('pty-1')
    expect(emits).toHaveLength(0)

    unsubscribe()
    expect(emits).toHaveLength(1)
  })
})
