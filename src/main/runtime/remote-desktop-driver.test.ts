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

function createRuntime() {
  const runtime = new OrcaRuntimeService(store)
  const ptySizes = new Map<string, { cols: number; rows: number }>([
    ['pty-1', { cols: 150, rows: 40 }]
  ])
  const driverEvents: { ptyId: string; driver: { kind: string; clientId?: string } }[] = []
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    resize: (ptyId, cols, rows) => {
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
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: (ptyId, driver) => {
      driverEvents.push({ ptyId, driver: { ...driver } })
    }
  })
  return { runtime, driverEvents }
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

  it('sizes the PTY to the SMALLEST attached viewer (smallest client wins)', async () => {
    const { runtime } = createRuntime()
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 100, 40)
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 100, rows: 40 })

    // A narrower viewer joins — the PTY shrinks so its wider frames never
    // overflow the narrow grid.
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-B', 'viewer-B', 80, 30)
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 80, rows: 30 })

    // The wide viewer growing does not widen the PTY past the narrow viewer.
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 140, 50)
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 80, rows: 30 })

    // The narrow viewer leaves — the PTY re-fits to the survivor's width.
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
    const { runtime } = createRuntime()
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
  })

  it('isPtyResizeDrivenRemotely is false for idle and desktop drivers', async () => {
    const { runtime } = createRuntime()
    expect(runtime.isPtyResizeDrivenRemotely('pty-1')).toBe(false)
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 100, 40)
    await runtime.unregisterRemoteDesktopViewer('pty-1', 'sub-A')
    expect(runtime.isPtyResizeDrivenRemotely('pty-1')).toBe(false)
  })

  it('reclaims the host width when the last viewer detaches', async () => {
    const { runtime } = createRuntime()
    // The host renderer reports its own 120-wide geometry (pty:reportGeometry).
    runtime.recordRemoteDesktopHostReclaimTarget('pty-1', 120, 40)
    // The viewer drives the source PTY to its own 80-wide viewport.
    await runtime.updateRemoteDesktopViewer('pty-1', 'sub-A', 'viewer-A', 80, 40)
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 80, rows: 40 })

    // Detaching the last viewer must actively resize the PTY back to the host's
    // OWN width (120), not the departed viewer's polluted 80.
    await runtime.unregisterRemoteDesktopViewer('pty-1', 'sub-A')
    expect(runtime.getTerminalSize('pty-1')).toEqual({ cols: 120, rows: 40 })
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
