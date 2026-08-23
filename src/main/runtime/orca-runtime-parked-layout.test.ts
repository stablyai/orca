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

function createRuntime(
  ptyId = 'pty-1',
  initialSize = { cols: 150, rows: 40 }
): {
  runtime: OrcaRuntimeService
  ptySizes: Map<string, { cols: number; rows: number }>
  resizes: { ptyId: string; cols: number; rows: number }[]
} {
  const runtime = new OrcaRuntimeService(store)
  const ptySizes = new Map([[ptyId, initialSize]])
  const resizes: { ptyId: string; cols: number; rows: number }[] = []
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    resize: (ptyId, cols, rows) => {
      ptySizes.set(ptyId, { cols, rows })
      resizes.push({ ptyId, cols, rows })
      return true
    },
    getSize: (ptyId) => ptySizes.get(ptyId) ?? null
  })
  return { runtime, ptySizes, resizes }
}

function syncTerminalGraph(
  runtime: OrcaRuntimeService,
  options: {
    ptyId: string
    incarnationId: string
    connectionId?: string | null
    visible?: boolean
  }
): void {
  const { ptyId, incarnationId, connectionId = null, visible = true } = options
  runtime.registerPty(ptyId, WORKTREE_ID, connectionId, {
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
            ptyId
          }
        ]
      : []
  })
}

function syncPtyGraph(runtime: OrcaRuntimeService, incarnationId: string, visible = true): void {
  syncTerminalGraph(runtime, { ptyId: 'pty-1', incarnationId, visible })
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

  it('restores local desktop layout after a parked remote owner closes', async () => {
    const { runtime, ptySizes, resizes } = createRuntime()
    syncPtyGraph(runtime, 'v1')
    await runtime.updateRemoteDesktopViewer('pty-1', 'owner-1', 'desktop-1', 100, 25)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 100, rows: 25 })

    syncPtyGraph(runtime, 'v1', false)
    resizes.length = 0
    await runtime.unregisterRemoteDesktopViewer('pty-1', 'owner-1')

    expect(resizes).toEqual([])
    syncPtyGraph(runtime, 'v1')
    await vi.waitFor(() => expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 }))
    expect(runtime.isRemoteDesktopViewerOwner('pty-1', 'owner-1')).toBe(false)
    expect(runtime.getAllTerminalFitOverrides().has('pty-1')).toBe(false)
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })
  })

  it('restores the SSH host target only after its exact parked claim re-enters', async () => {
    const ptyId = 'ssh:ssh-1@@remote-pty'
    const { runtime, ptySizes, resizes } = createRuntime(ptyId, { cols: 120, rows: 30 })
    const sync = (visible: boolean) =>
      syncTerminalGraph(runtime, {
        ptyId,
        incarnationId: 'ssh-v1',
        connectionId: 'ssh-1',
        visible
      })
    sync(true)
    await runtime.updateRemoteDesktopViewer(ptyId, 'owner-1', 'desktop-1', 100, 25)

    sync(false)
    resizes.length = 0
    await runtime.claimRemoteDesktopHost(ptyId, 120, 30)

    expect(resizes).toEqual([])
    expect(ptySizes.get(ptyId)).toEqual({ cols: 100, rows: 25 })
    sync(true)
    await vi.waitFor(() => expect(ptySizes.get(ptyId)).toEqual({ cols: 120, rows: 30 }))
    expect(resizes).toContainEqual({ ptyId, cols: 120, rows: 30 })
  })

  it('keeps the live parked remote owner when a non-owner closes', async () => {
    const { runtime, ptySizes, resizes } = createRuntime()
    syncPtyGraph(runtime, 'v1')
    await runtime.updateRemoteDesktopViewer('pty-1', 'non-owner', 'desktop-1', 110, 28, false)
    await runtime.updateRemoteDesktopViewer('pty-1', 'owner-1', 'desktop-2', 100, 25)

    syncPtyGraph(runtime, 'v1', false)
    resizes.length = 0
    await runtime.unregisterRemoteDesktopViewer('pty-1', 'non-owner')

    expect(resizes).toEqual([])
    syncPtyGraph(runtime, 'v1')
    await vi.advanceTimersByTimeAsync(0)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 100, rows: 25 })
    expect(runtime.isRemoteDesktopViewerOwner('pty-1', 'owner-1')).toBe(true)
  })

  it('prefers a new live parked owner over a deferred desktop reclaim', async () => {
    const { runtime, ptySizes, resizes } = createRuntime()
    syncPtyGraph(runtime, 'v1')
    await runtime.updateRemoteDesktopViewer('pty-1', 'owner-1', 'desktop-1', 100, 25)
    syncPtyGraph(runtime, 'v1', false)
    await runtime.claimRemoteDesktopHost('pty-1', 150, 40)
    await runtime.updateRemoteDesktopViewer('pty-1', 'owner-2', 'desktop-2', 80, 22)
    resizes.length = 0

    syncPtyGraph(runtime, 'v1')
    await vi.waitFor(() => expect(ptySizes.get('pty-1')).toEqual({ cols: 80, rows: 22 }))
    expect(resizes).not.toContainEqual({ ptyId: 'pty-1', cols: 150, rows: 40 })
    expect(runtime.isRemoteDesktopViewerOwner('pty-1', 'owner-2')).toBe(true)
  })

  it('does not carry a parked v1 owner-close reclaim into v2', async () => {
    const { runtime, ptySizes, resizes } = createRuntime()
    syncPtyGraph(runtime, 'v1')
    await runtime.updateRemoteDesktopViewer('pty-1', 'owner-1', 'desktop-1', 100, 25)
    syncPtyGraph(runtime, 'v1', false)
    await runtime.unregisterRemoteDesktopViewer('pty-1', 'owner-1')

    runtime.onPtySpawned('pty-1', 'v2')
    ptySizes.set('pty-1', { cols: 132, rows: 36 })
    resizes.length = 0
    syncPtyGraph(runtime, 'v2')
    await vi.advanceTimersByTimeAsync(0)

    expect(resizes).toEqual([])
    expect(ptySizes.get('pty-1')).toEqual({ cols: 132, rows: 36 })
  })

  it.each([
    ['local', 'reused-pty', null],
    ['SSH', 'ssh:ssh-1@@reused-pty', 'ssh-1']
  ])(
    'keeps new %s subscriptions across provider reset and repeated v2 registration',
    async (_label, ptyId, connectionId) => {
      const { runtime, ptySizes, resizes } = createRuntime(ptyId, { cols: 120, rows: 30 })
      const sync = (incarnationId: string, visible: boolean) =>
        syncTerminalGraph(runtime, { ptyId, incarnationId, connectionId, visible })
      sync('v1', true)
      await runtime.handleMobileSubscribe(ptyId, 'phone-v1', { cols: 45, rows: 20 })
      await runtime.updateRemoteDesktopViewer(ptyId, 'viewer-v1', 'desktop-v1', 100, 25)
      sync('v1', false)

      runtime.synchronizePtyOutputSequenceFromProvider(
        ptyId,
        { value: 0, generation: 'reset' },
        runtime.getPtyOutputSequence(ptyId)
      )
      runtime.registerPty(ptyId, WORKTREE_ID, connectionId, {
        tabId: 'tab-1',
        leafId: 'leaf-1',
        incarnationId: 'v2'
      })
      await runtime.handleMobileSubscribe(ptyId, 'phone-v2', { cols: 60, rows: 25 })
      await runtime.updateRemoteDesktopViewer(ptyId, 'viewer-v2', 'desktop-v2', 90, 24)
      runtime.registerPty(ptyId, WORKTREE_ID, connectionId, {
        tabId: 'tab-1',
        leafId: 'leaf-1',
        incarnationId: 'v2'
      })
      resizes.length = 0

      sync('v2', true)
      await vi.waitFor(() => expect(ptySizes.get(ptyId)).toEqual({ cols: 60, rows: 25 }))
      expect(runtime.getDriver(ptyId)).toEqual({ kind: 'mobile', clientId: 'phone-v2' })
      expect(runtime.isRemoteDesktopViewerOwner(ptyId, 'viewer-v2')).toBe(true)
      expect(runtime.isRemoteDesktopViewerOwner(ptyId, 'viewer-v1')).toBe(false)
      expect(resizes).toContainEqual({ ptyId, cols: 60, rows: 25 })
    }
  )

  it('keeps v2 idle when its replacement streams close before graph reentry', async () => {
    const ptyId = 'reused-pty'
    const { runtime, resizes } = createRuntime(ptyId, { cols: 120, rows: 30 })
    const sync = (incarnationId: string, visible: boolean) =>
      syncTerminalGraph(runtime, { ptyId, incarnationId, visible })
    sync('v1', true)
    await runtime.handleMobileSubscribe(ptyId, 'phone-v1', { cols: 45, rows: 20 })
    await runtime.updateRemoteDesktopViewer(ptyId, 'viewer-v1', 'desktop-v1', 100, 25)
    sync('v1', false)

    runtime.synchronizePtyOutputSequenceFromProvider(
      ptyId,
      { value: 0, generation: 'reset' },
      runtime.getPtyOutputSequence(ptyId)
    )
    runtime.registerPty(ptyId, WORKTREE_ID, null, {
      tabId: 'tab-1',
      leafId: 'leaf-1',
      incarnationId: 'v2'
    })
    await runtime.handleMobileSubscribe(ptyId, 'phone-v2', { cols: 60, rows: 25 })
    await runtime.updateRemoteDesktopViewer(ptyId, 'viewer-v2', 'desktop-v2', 90, 24)
    runtime.handleMobileUnsubscribe(ptyId, 'phone-v2')
    await runtime.unregisterRemoteDesktopViewer(ptyId, 'viewer-v2')
    resizes.length = 0

    sync('v2', true)
    await vi.advanceTimersByTimeAsync(0)
    expect(runtime.getDriver(ptyId)).toEqual({ kind: 'idle' })
    expect(runtime.isMobileSubscriberActive(ptyId)).toBe(false)
    expect(runtime.isRemoteDesktopViewerOwner(ptyId, 'viewer-v2')).toBe(false)
    expect(resizes).toEqual([])
  })
})
