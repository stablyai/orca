/**
 * Multi-desktop PTY size arbitration: host ↔ remote desktop must not
 * last-writer-win via passive reassertion. Control resize claims ownership;
 * observe (subscribe) does not; reclaim restores local ownership.
 */
import { describe, expect, it, vi } from 'vitest'
import type * as GitUsernameModule from '../git/git-username'
import { OrcaRuntimeService } from './orca-runtime'
import { LOCAL_DESKTOP_CLIENT_ID } from './desktop-size-ownership'

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
  const resizes: { ptyId: string; cols: number; rows: number }[] = []
  const fitOverrideEvents: { ptyId: string; mode: string; cols: number; rows: number }[] = []

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
    terminalDriverChanged: vi.fn()
  })

  return { runtime, ptySizes, resizes, fitOverrideEvents }
}

describe('desktop size arbitration (multi-client)', () => {
  it('observe intent does not resize, claim ownership, or pollute host restore baseline', async () => {
    const { runtime, ptySizes, resizes } = createRuntime()
    // Host claims first and records restore baseline.
    runtime.onExternalPtyResize('pty-1', 150, 40)
    expect(runtime.getLastRendererSize('pty-1')).toEqual({ cols: 150, rows: 40 })

    expect(
      await runtime.updateDesktopViewport(
        'pty-1',
        { cols: 80, rows: 24 },
        { clientId: 'desktop:b', intent: 'observe' }
      )
    ).toBe(true)

    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    expect(resizes).toEqual([])
    expect(runtime.getDesktopSizeOwner('pty-1')?.clientId).toBe(LOCAL_DESKTOP_CLIENT_ID)
    // Why (Codex #1): observe must not write lastRendererSizes.
    expect(runtime.getLastRendererSize('pty-1')).toEqual({ cols: 150, rows: 40 })
  })

  it('host restore after remote observe+control returns original host size', async () => {
    const { runtime, ptySizes } = createRuntime()
    runtime.onExternalPtyResize('pty-1', 150, 40)

    await runtime.updateDesktopViewport(
      'pty-1',
      { cols: 80, rows: 24 },
      { clientId: 'desktop:b', intent: 'observe' }
    )
    await runtime.updateDesktopViewport(
      'pty-1',
      { cols: 100, rows: 30 },
      { clientId: 'desktop:b', intent: 'control' }
    )
    expect(ptySizes.get('pty-1')).toEqual({ cols: 100, rows: 30 })

    expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)

    // Not 80×24 (observe pollution) and not 100×30 (remote control).
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    expect(runtime.getDesktopSizeOwner('pty-1')?.clientId).toBe(LOCAL_DESKTOP_CLIENT_ID)
  })

  it('remote control resize claims ownership and parks the host', async () => {
    const { runtime, ptySizes, fitOverrideEvents } = createRuntime()
    runtime.onExternalPtyResize('pty-1', 150, 40)
    fitOverrideEvents.length = 0

    expect(
      await runtime.updateDesktopViewport(
        'pty-1',
        { cols: 100, rows: 30 },
        { clientId: 'desktop:b', intent: 'control' }
      )
    ).toBe(true)

    expect(ptySizes.get('pty-1')).toEqual({ cols: 100, rows: 30 })
    expect(runtime.getDesktopSizeOwner('pty-1')?.clientId).toBe('desktop:b')
    expect(fitOverrideEvents.at(-1)).toEqual({
      ptyId: 'pty-1',
      mode: 'remote-desktop-fit',
      cols: 100,
      rows: 30
    })
    expect(runtime.getFitHoldForViewer('pty-1', LOCAL_DESKTOP_CLIENT_ID).mode).toBe(
      'remote-desktop-fit'
    )
    expect(runtime.getFitHoldForViewer('pty-1', 'desktop:b').mode).toBe('desktop-fit')
  })

  it('host reassertion echo of remote size does not reclaim ownership', async () => {
    const { runtime, ptySizes } = createRuntime()
    await runtime.updateDesktopViewport(
      'pty-1',
      { cols: 100, rows: 30 },
      { clientId: 'desktop:b', intent: 'control' }
    )

    // Host parked at remote size; reassertion would echo 100×30.
    runtime.onExternalPtyResize('pty-1', 100, 30)

    expect(runtime.getDesktopSizeOwner('pty-1')?.clientId).toBe('desktop:b')
    expect(ptySizes.get('pty-1')).toEqual({ cols: 100, rows: 30 })
  })

  it('host reclaim restores local size and clears remote hold', async () => {
    const { runtime, ptySizes, fitOverrideEvents } = createRuntime()
    runtime.onExternalPtyResize('pty-1', 150, 40)
    await runtime.updateDesktopViewport(
      'pty-1',
      { cols: 100, rows: 30 },
      { clientId: 'desktop:b', intent: 'control' }
    )
    fitOverrideEvents.length = 0

    expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)

    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    expect(runtime.getDesktopSizeOwner('pty-1')?.clientId).toBe(LOCAL_DESKTOP_CLIENT_ID)
    expect(fitOverrideEvents.at(-1)?.mode).toBe('desktop-fit')
    expect(runtime.getFitHoldForViewer('pty-1', 'desktop:b').mode).toBe('remote-desktop-fit')
  })

  it('host intentional resize reclaims from remote owner', async () => {
    const { runtime, ptySizes, resizes } = createRuntime()
    await runtime.updateDesktopViewport(
      'pty-1',
      { cols: 100, rows: 30 },
      { clientId: 'desktop:b', intent: 'control' }
    )
    resizes.length = 0

    // Simulate host pty:resize IPC: provider resize then onExternalPtyResize.
    ptySizes.set('pty-1', { cols: 160, rows: 45 })
    runtime.onExternalPtyResize('pty-1', 160, 45)

    expect(runtime.getDesktopSizeOwner('pty-1')?.clientId).toBe(LOCAL_DESKTOP_CLIENT_ID)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 160, rows: 45 })
  })

  it('getAllTerminalFitOverrides includes remote-desktop holds for host hydrate', async () => {
    const { runtime } = createRuntime()
    await runtime.updateDesktopViewport(
      'pty-1',
      { cols: 90, rows: 28 },
      { clientId: 'desktop:b', intent: 'control' }
    )

    const all = runtime.getAllTerminalFitOverrides()
    expect(all.get('pty-1')).toEqual({
      mode: 'remote-desktop-fit',
      cols: 90,
      rows: 28
    })
  })

  it('releases remote ownership without disturbing mobile-fit priority', async () => {
    const { runtime, ptySizes, resizes } = createRuntime()
    expect(
      await runtime.updateDesktopViewport(
        'pty-1',
        { cols: 120, rows: 40 },
        { clientId: 'desktop:b', intent: 'control' }
      )
    ).toBe(true)
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
    resizes.length = 0

    expect(runtime.releaseRemoteDesktopSizeOwner('pty-1', 'desktop:b')).toBe(true)

    expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
    expect(resizes).toEqual([])
    expect(runtime.getDesktopSizeOwner('pty-1')).toBeNull()
    expect(runtime.getTerminalFitOverride('pty-1')?.mode).toBe('mobile-fit')
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
  })

  it('releases only the expected remote owner and restores host size', async () => {
    const { runtime, ptySizes, fitOverrideEvents } = createRuntime()
    runtime.onExternalPtyResize('pty-1', 150, 40)
    await runtime.updateDesktopViewport(
      'pty-1',
      { cols: 100, rows: 30 },
      { clientId: 'desktop:tab-b:leaf-b', intent: 'control' }
    )
    fitOverrideEvents.length = 0

    expect(runtime.releaseRemoteDesktopSizeOwner('pty-1', 'desktop:tab-a:leaf-a')).toBe(false)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 100, rows: 30 })
    expect(runtime.getDesktopSizeOwner('pty-1')?.clientId).toBe('desktop:tab-b:leaf-b')
    expect(fitOverrideEvents).toEqual([])

    expect(runtime.releaseRemoteDesktopSizeOwner('pty-1', 'desktop:tab-b:leaf-b')).toBe(true)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    expect(runtime.getDesktopSizeOwner('pty-1')?.clientId).toBe(LOCAL_DESKTOP_CLIENT_ID)
    expect(fitOverrideEvents.at(-1)?.mode).toBe('desktop-fit')
  })

  it('remote owner disconnect restores host size and clears the hold overlay', async () => {
    const { runtime, ptySizes, fitOverrideEvents } = createRuntime()
    runtime.onExternalPtyResize('pty-1', 150, 40)
    await runtime.updateDesktopViewport(
      'pty-1',
      { cols: 100, rows: 30 },
      { clientId: 'desktop:b', intent: 'control' }
    )
    expect(runtime.getDesktopSizeOwner('pty-1')?.clientId).toBe('desktop:b')
    fitOverrideEvents.length = 0

    runtime.onClientDisconnected('desktop:b')

    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    expect(runtime.getDesktopSizeOwner('pty-1')?.clientId).toBe(LOCAL_DESKTOP_CLIENT_ID)
    expect(fitOverrideEvents.at(-1)?.mode).toBe('desktop-fit')
    expect(runtime.getFitHoldForViewer('pty-1', LOCAL_DESKTOP_CLIENT_ID).mode).toBe('desktop-fit')
  })

  it('observe under phone-fit does not poison host restore baseline', async () => {
    const { runtime, ptySizes } = createRuntime()
    runtime.onExternalPtyResize('pty-1', 150, 40)
    expect(runtime.getLastRendererSize('pty-1')).toEqual({ cols: 150, rows: 40 })

    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

    // Remote subscribe observe while phone holds — must not rewrite baseline.
    await runtime.updateDesktopViewport(
      'pty-1',
      { cols: 80, rows: 24 },
      { clientId: 'desktop:b', intent: 'observe' }
    )
    expect(runtime.getLastRendererSize('pty-1')).toEqual({ cols: 150, rows: 40 })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
  })
})
