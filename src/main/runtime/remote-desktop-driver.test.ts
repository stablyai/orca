/**
 * Tests for the remote-desktop viewer width driver.
 *
 * A remote (relay/shared-control) desktop viewer takes the PTY width floor so
 * the host's own fit cascade stops resizing the viewed PTY out from under it
 * (the remote alt-screen "porridge"). Mirrors the mobile presence lock but
 * suppresses only RESIZE, never input. Covers:
 *   - idle → remote-desktop on register; release to idle on last unregister
 *   - multi-viewer: driver survives until the last viewer detaches
 *   - a live mobile driver outranks a remote-desktop viewer
 *   - isPtyResizeDrivenRemotely gates host resize for mobile AND remote-desktop
 *   - PTY exit clears the remote-desktop registry
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type * as GitUsernameModule from '../git/git-username'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))
vi.mock('../hooks', () => ({
  createSetupRunnerScript: vi.fn(),
  getEffectiveHooks: vi.fn().mockReturnValue(null),
  runHook: vi.fn().mockResolvedValue({ success: true, output: '' })
}))
vi.mock('../ipc/worktree-logic', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, computeWorktreePath: vi.fn(), ensurePathWithinWorkspace: vi.fn() }
})
vi.mock('../ipc/filesystem-auth', () => ({ invalidateAuthorizedRootsCache: vi.fn() }))
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
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: '',
    mobileAutoRestoreFitMs: 5_000
  })
}

function createRuntime(mobileAutoRestoreFitMs: number | null = 5_000) {
  const runtime = new OrcaRuntimeService({
    ...store,
    getSettings: () => ({ ...store.getSettings(), mobileAutoRestoreFitMs })
  })
  const ptySizes = new Map<string, { cols: number; rows: number }>([
    ['pty-1', { cols: 150, rows: 40 }]
  ])
  const resizeCalls: { ptyId: string; cols: number; rows: number }[] = []
  const driverEvents: { ptyId: string; driver: { kind: string; clientId?: string } }[] = []
  const fitOverrideEvents: { ptyId: string; mode: string; cols: number; rows: number }[] = []
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    resize: (ptyId, cols, rows) => {
      resizeCalls.push({ ptyId, cols, rows })
      ptySizes.set(ptyId, { cols, rows })
      return true
    },
    getSize: (ptyId) => ptySizes.get(ptyId) ?? null
  })
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: (ptyId, mode, cols, rows) => {
      fitOverrideEvents.push({ ptyId, mode, cols, rows })
    },
    terminalDriverChanged: (ptyId, driver) => {
      driverEvents.push({ ptyId, driver: { ...driver } })
    }
  })
  return {
    runtime,
    driverEvents,
    fitOverrideEvents,
    resizeCalls
  }
}

describe('remote desktop viewer width driver', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('applying a viewport suppresses host resize without touching driver state', async () => {
    const { runtime, driverEvents } = createRuntime()
    expect(runtime.isPtyResizeDrivenRemotely('pty-1')).toBe(false)

    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 100, 40)

    expect(runtime.isPtyResizeDrivenRemotely('pty-1')).toBe(true)
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 100, rows: 40 })
    // It is deliberately NOT a driver kind: the presence-lock state machine and
    // its cross-layer driver-change notifications stay untouched.
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })
    expect(driverEvents).toHaveLength(0)
  })

  it('sizes the PTY to the latest active desktop viewer', async () => {
    const { runtime } = createRuntime()
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 100, 40)
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 100, rows: 40 })

    // Activity on the narrower viewer transfers ownership to it.
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-B', 'viewer-B', 80, 30)
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 80, rows: 30 })

    // Later activity on the wide viewer transfers ownership back.
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 140, 50)
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 140, rows: 50 })

    // A passive peer leaving cannot disturb the active owner.
    await runtime.unregisterRemoteDesktopViewer('pty-1', 'sub-B')
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 140, rows: 50 })
  })

  it('stops suppressing host resize only when the LAST viewer detaches', async () => {
    const { runtime } = createRuntime()
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 100, 40)
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-B', 'viewer-B', 80, 40)
    expect(runtime.isPtyResizeDrivenRemotely('pty-1')).toBe(true)

    // First viewer leaves — another remote viewer still holds the floor.
    await runtime.unregisterRemoteDesktopViewer('pty-1', 'sub-A')
    expect(runtime.isPtyResizeDrivenRemotely('pty-1')).toBe(true)

    // Last viewer leaves — the host reclaims its own width (next pty:resize applies).
    await runtime.unregisterRemoteDesktopViewer('pty-1', 'sub-B')
    expect(runtime.isPtyResizeDrivenRemotely('pty-1')).toBe(false)
  })

  it('coexists with a mobile driver and outlives it (host stays suppressed)', async () => {
    const { runtime, fitOverrideEvents } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })

    // A desktop viewer registering must NOT disturb the mobile driver.
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 100, 40)
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
    expect(runtime.isPtyResizeDrivenRemotely('pty-1')).toBe(true)

    // When the phone leaves, the surviving viewer keeps host resize suppressed
    // (the registry is independent of the mobile driver state).
    runtime.onClientDisconnected('phone-A')
    vi.advanceTimersByTime(10_000)
    expect(runtime.getDriver('pty-1').kind).not.toBe('mobile')
    expect(runtime.isPtyResizeDrivenRemotely('pty-1')).toBe(true)
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 100, rows: 40 })
    expect(fitOverrideEvents.at(-1)).toMatchObject({
      ptyId: 'pty-1',
      mode: 'remote-desktop-fit',
      cols: 100,
      rows: 40
    })

    await runtime.unregisterRemoteDesktopViewer('pty-1', 'sub-A')
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 150, rows: 40 })
  })

  it('isPtyResizeDrivenRemotely is false for idle and desktop drivers', async () => {
    const { runtime } = createRuntime()
    expect(runtime.isPtyResizeDrivenRemotely('pty-1')).toBe(false)
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 100, 40)
    await runtime.unregisterRemoteDesktopViewer('pty-1', 'sub-A')
    expect(runtime.isPtyResizeDrivenRemotely('pty-1')).toBe(false)
  })

  it('does not let passive attachment or hydration steal host ownership', async () => {
    const { runtime, resizeCalls } = createRuntime()

    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 80, 24, false)
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 90, 30, false)

    expect(runtime.isPtyResizeDrivenRemotely('pty-1')).toBe(false)
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 150, rows: 40 })
    expect(resizeCalls).toHaveLength(0)
  })

  it('lets host activity automatically reclaim from a remote owner', async () => {
    const { runtime } = createRuntime()
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 80, 24)

    await runtime.claimRemoteDesktopHost('pty-1', 132, 42)

    expect(runtime.isPtyResizeDrivenRemotely('pty-1')).toBe(false)
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 132, rows: 42 })
    expect(runtime.getRemoteDesktopFitHold('pty-1', 'sub-A')).toMatchObject({
      mode: 'remote-desktop-fit',
      cols: 132,
      rows: 42
    })
  })

  it('does not emit resize churn for repeated activity from the current owner', async () => {
    const { runtime, resizeCalls, fitOverrideEvents } = createRuntime()
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 100, 30)
    resizeCalls.splice(0)
    fitOverrideEvents.splice(0)

    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 100, 30)

    expect(resizeCalls).toHaveLength(0)
    expect(fitOverrideEvents).toHaveLength(0)
  })

  it('reclaims the host width when the last viewer detaches', async () => {
    const { runtime } = createRuntime()
    // The viewer drives the source PTY to its own 80-wide viewport.
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 80, 40)
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 80, rows: 40 })
    // While the viewer owns width, the blocked host fit records the host's
    // latest reclaim geometry.
    runtime.recordRemoteDesktopHostReclaimTarget('pty-1', 120, 40)

    // Detaching the last viewer must actively resize the PTY back to the host's
    // OWN width (120), not the departed viewer's polluted 80.
    await runtime.unregisterRemoteDesktopViewer('pty-1', 'sub-A')
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 120, rows: 40 })
  })

  it('does not retain a remote reclaim target when only a phone suppresses host resize', async () => {
    const { runtime } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })

    // pty:resize is suppressed for mobile too, but this measurement must not
    // seed the separate remote-viewer cache when no desktop viewer exists.
    runtime.recordRemoteDesktopHostReclaimTarget('pty-1', 120, 35)
    runtime.onClientDisconnected('phone-A')
    await vi.advanceTimersByTimeAsync(10_000)

    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 80, 24)
    await runtime.unregisterRemoteDesktopViewer('pty-1', 'sub-A')

    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 150, rows: 40 })
  })

  it('restores and consumes the host target when the last viewer leaves during phone-fit', async () => {
    const { runtime } = createRuntime()
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 100, 30)
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    await runtime.unregisterRemoteDesktopViewer('pty-1', 'sub-A')
    // The host pane can change after remote ownership ends while phone-fit
    // remains active; its trusted measurement becomes the deferred target.
    runtime.recordRendererGeometry('pty-1', 140, 38)

    runtime.onClientDisconnected('phone-A')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 140, rows: 38 })

    // A later viewer must capture the new host geometry, not reuse the prior
    // session's already-consumed 140-column reclaim target.
    runtime.onExternalPtyResize('pty-1', 130, 36)
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-B', 'viewer-B', 80, 24)
    await runtime.unregisterRemoteDesktopViewer('pty-1', 'sub-B')
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 130, rows: 36 })
  })

  it('preserves indefinite phone-fit after the last desktop viewer leaves', async () => {
    const { runtime } = createRuntime(null)
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 100, 30)
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    await runtime.unregisterRemoteDesktopViewer('pty-1', 'sub-A')

    runtime.onClientDisconnected('phone-A')
    await vi.advanceTimersByTimeAsync(10_000)

    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 45, rows: 20 })
    expect(runtime.getTerminalFitOverride('pty-1')).toMatchObject({ mode: 'mobile-fit' })

    await expect(runtime.reclaimTerminalForDesktop('pty-1')).resolves.toBe(true)
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 150, rows: 40 })
    expect(runtime.getTerminalFitOverride('pty-1')).toBeNull()
  })

  it('does not let an older host reclaim consume a newer viewer cycle target', async () => {
    const { runtime } = createRuntime()
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 80, 24)

    // Do not await the reclaim before the next viewer joins. The serialized
    // host resize can finish after sub-B has established a newer viewer cycle.
    const firstReclaim = runtime.unregisterRemoteDesktopViewer('pty-1', 'sub-A')
    const secondAttach = runtime.updateRemoteDesktopViewer('pty-1', 'sub-B', 'viewer-B', 90, 30)
    await Promise.all([firstReclaim, secondAttach])

    await runtime.unregisterRemoteDesktopViewer('pty-1', 'sub-B')
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 150, rows: 40 })
  })

  it('does not coalesce queued claims from different desktop owners', async () => {
    const { runtime } = createRuntime()
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 100, 30)
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-B', 'viewer-B', 80, 24, false)
    const layoutQueues = Reflect.get(runtime, 'layoutQueues') as Map<
      string,
      { running: Promise<unknown>; pending: { target: { ownerSubscriptionKey?: string } }[] }
    >
    layoutQueues.set('pty-1', { running: new Promise(() => {}), pending: [] })

    void runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 90, 28)
    void runtime.claimRemoteDesktopViewer('pty-1', 'sub-B')

    expect(
      layoutQueues.get('pty-1')?.pending.map(({ target }) => target.ownerSubscriptionKey)
    ).toEqual(['sub-A', 'sub-B'])
    layoutQueues.delete('pty-1')
  })

  it('makes a host claim join a pending disconnect reclaim', async () => {
    const { runtime } = createRuntime()
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 80, 24)
    const layoutQueues = Reflect.get(runtime, 'layoutQueues') as Map<
      string,
      { running: Promise<unknown>; pending: { waiters: unknown[] }[] }
    >
    layoutQueues.set('pty-1', { running: new Promise(() => {}), pending: [] })

    void runtime.unregisterRemoteDesktopViewer('pty-1', 'sub-A')
    void runtime.claimRemoteDesktopHost('pty-1', 150, 40)

    expect(layoutQueues.get('pty-1')?.pending).toHaveLength(1)
    expect(layoutQueues.get('pty-1')?.pending[0]?.waiters).toHaveLength(2)
    layoutQueues.delete('pty-1')
  })

  it('removes same-PTY viewer floors with one bounded reclaim', async () => {
    const { runtime, resizeCalls } = createRuntime()
    const subscriptionKeys: string[] = []
    for (let index = 0; index < 100; index += 1) {
      const key = `sub-${index}`
      subscriptionKeys.push(key)
      await runtime.updateRemoteDesktopViewer('pty-1', key, `viewer-${index}`, 100, 30)
    }
    resizeCalls.splice(0)

    await runtime.unregisterRemoteDesktopViewers('pty-1', subscriptionKeys)

    expect(resizeCalls).toEqual([{ ptyId: 'pty-1', cols: 150, rows: 40 }])
  })

  it('applies the latest viewer width when the host takes back from a phone', async () => {
    const { runtime } = createRuntime()
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 100, 30)
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 80, 24)

    await expect(runtime.reclaimTerminalForDesktop('pty-1')).resolves.toBe(true)

    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 80, rows: 24 })
    expect(runtime.isPtyResizeDrivenRemotely('pty-1')).toBe(true)
  })

  it('refresh never creates a floor (one-shot viewport cannot leak host suppression)', async () => {
    const { runtime } = createRuntime()
    // A one-shot terminal.updateViewport (refresh) from a viewer with no stream
    // floor must NOT register one — that floor would leak (nothing releases a
    // one-shot RPC's state), pinning the host at a stale width forever.
    const created = await runtime.refreshRemoteDesktopViewer('pty-1', 'viewer-A', 90, 30)
    expect(created).toBe(false)
    expect(runtime.isPtyResizeDrivenRemotely('pty-1')).toBe(false)
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 150, rows: 40 })

    // Once the client's STREAM registers the floor (and owns its cleanup), a
    // refresh updates that same floor by clientId.
    await runtime.updateRemoteDesktopViewer('pty-1', 'stream:1', 'viewer-A', 100, 40)
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 100, rows: 40 })
    const refreshed = await runtime.refreshRemoteDesktopViewer('pty-1', 'viewer-A', 70, 25)
    expect(refreshed).toBe(true)
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 70, rows: 25 })

    // A refresh for a DIFFERENT client that owns no floor is a no-op.
    const other = await runtime.refreshRemoteDesktopViewer('pty-1', 'viewer-Z', 60, 20)
    expect(other).toBe(false)
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 70, rows: 25 })

    // The stream cleanup releases the sole floor — the refresh left no orphan,
    // so the host reclaims (suppression drops).
    await runtime.unregisterRemoteDesktopViewer('pty-1', 'stream:1')
    expect(runtime.isPtyResizeDrivenRemotely('pty-1')).toBe(false)
  })

  it('captures host geometry when a passive stream is first claimed by terminal.send', async () => {
    const { runtime } = createRuntime()
    await runtime.updateRemoteDesktopViewer('pty-1', 'stream:1', 'viewer-A', 100, 30, false)

    await runtime.refreshRemoteDesktopViewer('pty-1', 'viewer-A', 80, 24, true)
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 80, rows: 24 })
    await runtime.unregisterRemoteDesktopViewer('pty-1', 'stream:1')

    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 150, rows: 40 })
  })

  it('keeps the host reclaim target when the reclaim resize fails', async () => {
    const { runtime } = createRuntime()
    const ptySizes = new Map<string, { cols: number; rows: number }>([
      ['pty-1', { cols: 150, rows: 40 }]
    ])
    let resizeSucceeds = true
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      resize: (ptyId, cols, rows) => {
        if (!resizeSucceeds) {
          return false
        }
        ptySizes.set(ptyId, { cols, rows })
        return true
      },
      getSize: (ptyId) => ptySizes.get(ptyId) ?? null
    })

    // A viewer drives the PTY to 80; while it owns width, the host reports its
    // own 120-wide reclaim geometry.
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 80, 40)
    runtime.recordRemoteDesktopHostReclaimTarget('pty-1', 120, 40)
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 80, rows: 40 })

    // The last viewer leaves but the reclaim resize fails: the PTY is stuck at
    // 80, so the recorded host target (120) MUST be retained for a later retry.
    resizeSucceeds = false
    await runtime.unregisterRemoteDesktopViewer('pty-1', 'sub-A')
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 80, rows: 40 })

    // A retry once resize works restores the TRUE host width (120), not the
    // stale viewer width (80) that a dropped target would have resolved to.
    resizeSucceeds = true
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-B', 'viewer-B', 80, 40)
    await runtime.unregisterRemoteDesktopViewer('pty-1', 'sub-B')
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 120, rows: 40 })
  })

  it('supersedes a failed reclaim target when the host later resizes successfully', async () => {
    const { runtime } = createRuntime()
    const ptySizes = new Map<string, { cols: number; rows: number }>([
      ['pty-1', { cols: 150, rows: 40 }]
    ])
    let resizeSucceeds = true
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      resize: (ptyId, cols, rows) => {
        if (!resizeSucceeds) {
          return false
        }
        ptySizes.set(ptyId, { cols, rows })
        return true
      },
      getSize: (ptyId) => ptySizes.get(ptyId) ?? null
    })

    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 80, 40)
    runtime.recordRemoteDesktopHostReclaimTarget('pty-1', 120, 40)
    resizeSucceeds = false
    await runtime.unregisterRemoteDesktopViewer('pty-1', 'sub-A')

    // pty:resize has already resized the provider before this runtime mirror
    // hook runs; that successful host geometry supersedes the retained 120.
    resizeSucceeds = true
    ptySizes.set('pty-1', { cols: 140, rows: 42 })
    runtime.onExternalPtyResize('pty-1', 140, 42)

    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-B', 'viewer-B', 80, 30)
    await runtime.unregisterRemoteDesktopViewer('pty-1', 'sub-B')
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 140, rows: 42 })
  })

  it('PTY exit clears the remote-desktop registry', async () => {
    const { runtime } = createRuntime()
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 100, 40)
    expect(runtime.isPtyResizeDrivenRemotely('pty-1')).toBe(true)

    runtime.onPtyExit('pty-1', 0)
    expect(runtime.isPtyResizeDrivenRemotely('pty-1')).toBe(false)

    // A fresh viewer on the same id re-establishes suppression cleanly (no stale set).
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-B', 'viewer-B', 100, 40)
    expect(runtime.isPtyResizeDrivenRemotely('pty-1')).toBe(true)
  })
})
