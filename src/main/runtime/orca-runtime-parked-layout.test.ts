import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitUsernameModule from '../git/git-username'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))
vi.mock('../hooks', () => ({
  getEffectiveHooks: vi.fn().mockReturnValue(null),
  runHook: vi.fn().mockResolvedValue({ success: true, output: '' })
}))
vi.mock('../worktree-runner-script', () => ({ createSetupRunnerScript: vi.fn() }))
vi.mock('../ipc/worktree-logic', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  computeWorktreePath: vi.fn(),
  ensurePathWithinWorkspace: vi.fn()
}))
vi.mock('../ipc/registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: vi.fn()
}))
vi.mock('../git/repo', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getDefaultBaseRef: vi.fn().mockReturnValue('origin/main'),
  getBranchConflictKind: vi.fn().mockResolvedValue(null)
}))
vi.mock('../git/git-username', async () => {
  const actual = await vi.importActual<typeof GitUsernameModule>('../git/git-username')
  return { ...actual, resolveLocalGitUsername: vi.fn(async () => '') }
})

const AUTO_RESTORE_MS = 5_000
const WINDOW_ID = 1
const WORKTREE_ID = 'worktree-1'
const store = {
  getRepo: () => undefined,
  getRepos: () => [],
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
    mobileAutoRestoreFitMs: AUTO_RESTORE_MS
  }),
  updateSettings: () => {}
}

function createRuntime(): {
  runtime: OrcaRuntimeService
  ptySizes: Map<string, { cols: number; rows: number }>
  resizes: { cols: number; rows: number }[]
} {
  const runtime = new OrcaRuntimeService(store)
  const ptySizes = new Map([['pty-1', { cols: 150, rows: 40 }]])
  const resizes: { cols: number; rows: number }[] = []
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    resize: (ptyId, cols, rows) => {
      ptySizes.set(ptyId, { cols, rows })
      resizes.push({ cols, rows })
      return true
    },
    getSize: (ptyId) => ptySizes.get(ptyId) ?? null
  })
  return { runtime, ptySizes, resizes }
}

function syncPtyGraph(runtime: OrcaRuntimeService, incarnationId: string, visible = true): void {
  runtime.registerPty('pty-1', WORKTREE_ID, null, {
    tabId: 'tab-1',
    leafId: 'leaf-1',
    incarnationId
  })
  runtime.attachWindow(WINDOW_ID)
  runtime.syncWindowGraph(WINDOW_ID, {
    tabs: visible
      ? [
          {
            tabId: 'tab-1',
            worktreeId: WORKTREE_ID,
            title: 'Terminal',
            activeLeafId: 'leaf-1',
            layout: null
          }
        ]
      : [],
    leaves: visible
      ? [
          {
            tabId: 'tab-1',
            worktreeId: WORKTREE_ID,
            leafId: 'leaf-1',
            paneRuntimeId: 1,
            ptyId: 'pty-1'
          }
        ]
      : []
  })
}

describe('parked terminal layout serialization', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('defers legacy mobile-fit and replays only the latest target on exact reentry', async () => {
    const { runtime, ptySizes, resizes } = createRuntime()
    syncPtyGraph(runtime, 'v1')
    await runtime.resizeForClient('pty-1', 'mobile-fit', 'client-old', 45, 20)

    syncPtyGraph(runtime, 'v1', false)
    resizes.length = 0
    await runtime.resizeForClient('pty-1', 'mobile-fit', 'client-old', 60, 25)

    expect(resizes).toEqual([])
    expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

    syncPtyGraph(runtime, 'v1')
    await vi.waitFor(() => expect(ptySizes.get('pty-1')).toEqual({ cols: 60, rows: 25 }))
    await runtime.resizeForClient('pty-1', 'restore', 'client-old')
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
  })

  it('defers finite auto-restore until the exact graph claim re-enters', async () => {
    const { runtime, ptySizes, resizes } = createRuntime()
    syncPtyGraph(runtime, 'v1')
    await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
    syncPtyGraph(runtime, 'v1', false)
    resizes.length = 0

    runtime.handleMobileUnsubscribe('pty-1', 'client-a')
    await vi.advanceTimersByTimeAsync(AUTO_RESTORE_MS)

    expect(resizes).toEqual([])
    expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

    syncPtyGraph(runtime, 'v1')
    await vi.waitFor(() => expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 }))
    expect(runtime.getTerminalFitOverride('pty-1')).toBeNull()
  })

  it('retires a parked v1 auto-restore timer before v2 can inherit it', async () => {
    const { runtime, ptySizes, resizes } = createRuntime()
    syncPtyGraph(runtime, 'v1')
    await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
    syncPtyGraph(runtime, 'v1', false)
    runtime.handleMobileUnsubscribe('pty-1', 'client-a')

    runtime.onPtySpawned('pty-1', 'v2')
    ptySizes.set('pty-1', { cols: 132, rows: 36 })
    resizes.length = 0
    await vi.advanceTimersByTimeAsync(AUTO_RESTORE_MS)

    expect(resizes).toEqual([])
    syncPtyGraph(runtime, 'v2')
    await vi.advanceTimersByTimeAsync(0)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 132, rows: 36 })
  })
})
