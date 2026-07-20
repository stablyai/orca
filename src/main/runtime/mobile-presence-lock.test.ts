/**
 * Tests for the presence-based mobile driver lock (see docs/mobile-presence-lock.md).
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
    // Why: default to a finite 5s (not the real null/indefinite) so legacy auto-restore tests still fire. See docs/mobile-fit-hold.md.
    mobileAutoRestoreFitMs: 5_000
  })
}

// Why (#7588): held-modal repro needs indefinite hold (null); legacy tests need the finite 5s default. Wrap per-test without mutating the shared stub.
function createRuntime(mobileAutoRestoreFitMs: number | null = 5_000) {
  const effectiveStore = {
    ...store,
    getSettings: () => ({ ...store.getSettings(), mobileAutoRestoreFitMs })
  }
  const runtime = new OrcaRuntimeService(effectiveStore)
  const ptySizes = new Map<string, { cols: number; rows: number }>([
    ['pty-1', { cols: 150, rows: 40 }]
  ])
  const resizes: { ptyId: string; cols: number; rows: number }[] = []
  const driverEvents: { ptyId: string; driver: { kind: string; clientId?: string } }[] = []
  const fitOverrideEvents: { ptyId: string; mode: string; cols: number; rows: number }[] = []
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
    terminalDriverChanged: (ptyId, driver) => {
      driverEvents.push({ ptyId, driver: { ...driver } })
    }
  })

  return {
    runtime,
    ptySizes,
    resizes,
    driverEvents,
    fitOverrideEvents,
    setResizeSucceeds: (next: boolean) => {
      resizeSucceeds = next
    }
  }
}

describe('mobile presence lock — driver state machine', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('starts idle for unknown PTY', () => {
    const { runtime } = createRuntime()
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })
  })

  it('handleMobileSubscribe in auto mode transitions idle → mobile{clientId}', async () => {
    const { runtime, driverEvents } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })

    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
    expect(driverEvents.at(-1)?.driver).toEqual({ kind: 'mobile', clientId: 'phone-A' })
  })

  it('handleMobileSubscribe in desktop mode is passive — does NOT take floor', async () => {
    const { runtime, driverEvents } = createRuntime()
    // Pretend a previous take-back put us in desktop mode.
    runtime.setMobileDisplayMode('pty-1', 'desktop')

    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })

    // Driver stays idle — the phone is passively watching at desktop dims.
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })
    expect(driverEvents.find((e) => e.driver.kind === 'mobile')).toBeUndefined()
  })

  it('reclaimTerminalForDesktop transitions mobile → desktop and is idempotent', async () => {
    const { runtime } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    expect(runtime.getDriver('pty-1').kind).toBe('mobile')

    expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'desktop' })

    // Idempotent — second call is a no-op (no active mobile subscriber left to reclaim from).
    expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'desktop' })
  })

  it('mobileTookFloor after reclaim re-applies phone-fit and flips driver back to mobile', async () => {
    const { runtime, ptySizes } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    await runtime.reclaimTerminalForDesktop('pty-1')
    expect(runtime.getDriver('pty-1').kind).toBe('desktop')
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })

    await runtime.mobileTookFloor('pty-1', 'phone-A')

    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
    // PTY is back at phone dims.
    expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
  })

  it('restores the pre-write driver after overlapping claims from one phone both fail', async () => {
    const { runtime } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    await runtime.reclaimTerminalForDesktop('pty-1')

    const first = runtime.beginMobileInputFloor('pty-1', 'phone-A')!
    const second = runtime.beginMobileInputFloor('pty-1', 'phone-A')!
    first.rollback()
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })

    second.rollback()
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'desktop' })
  })

  it('keeps a successful overlapping claim as the rollback baseline', async () => {
    const { runtime, ptySizes } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    await runtime.reclaimTerminalForDesktop('pty-1')

    const successful = runtime.beginMobileInputFloor('pty-1', 'phone-A')!
    const rejected = runtime.beginMobileInputFloor('pty-1', 'phone-A')!
    await successful.commit()
    rejected.rollback()

    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
  })

  it('does not let an older phone-fit completion retake a newer writer floor', async () => {
    const { runtime } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    await runtime.handleMobileSubscribe('pty-1', 'phone-B', { cols: 38, rows: 18 })
    await runtime.reclaimTerminalForDesktop('pty-1')

    let releaseFirstLayout!: () => void
    vi.spyOn(runtime, 'applyMobileDisplayMode').mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseFirstLayout = () => resolve(true)
        })
    )
    const first = runtime.beginMobileInputFloor('pty-1', 'phone-A')!
    const firstCommit = first.commit()
    await vi.waitFor(() => expect(releaseFirstLayout).toBeTypeOf('function'))

    const second = runtime.beginMobileInputFloor('pty-1', 'phone-B')!
    await second.commit()
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-B' })

    releaseFirstLayout()
    await firstCommit
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-B' })
  })

  it('mobile input without an active subscriber cannot create an orphaned floor lock', async () => {
    const { runtime } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    runtime.handleMobileUnsubscribe('pty-1', 'phone-A')
    await vi.advanceTimersByTimeAsync(250)

    await runtime.mobileTookFloor('pty-1', 'phone-A')

    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })
  })

  it('admits a soft-leaving client to reserve the input floor within the grace window', async () => {
    const { runtime } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    runtime.handleMobileUnsubscribe('pty-1', 'phone-A')

    // Inside the soft-leave grace a late write still reserves and commits the floor.
    const claim = runtime.beginMobileInputFloor('pty-1', 'phone-A')
    expect(claim).not.toBeNull()
    await claim!.commit()
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })

    // Past the grace the client is fully gone and is rejected.
    await vi.advanceTimersByTimeAsync(250)
    expect(runtime.beginMobileInputFloor('pty-1', 'phone-A')).toBeNull()
  })

  it('handleMobileUnsubscribe last leaver flips driver to idle after soft-leave grace', async () => {
    const { runtime, driverEvents } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })

    runtime.handleMobileUnsubscribe('pty-1', 'phone-A')

    // Why: soft-leave grace holds driver=mobile ~250ms so a keyboard show/hide re-subscribe doesn't flash the desktop banner.
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })

    await vi.advanceTimersByTimeAsync(250)
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })
    expect(driverEvents.at(-1)?.driver).toEqual({ kind: 'idle' })
  })

  it('resubscribe within soft-leave grace cancels idle without driver flap', async () => {
    const { runtime, driverEvents } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })

    runtime.handleMobileUnsubscribe('pty-1', 'phone-A')
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })

    // Same client re-subscribes inside the grace window — renderer must never observe idle.
    await vi.advanceTimersByTimeAsync(100)
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    await vi.advanceTimersByTimeAsync(500)

    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
    expect(driverEvents.find((e) => e.driver.kind === 'idle')).toBeUndefined()
  })

  it('onPtyExit clears driver state and emits idle', async () => {
    const { runtime, driverEvents } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })

    runtime.onPtyExit('pty-1', 0)

    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })
    // The last emitted event for pty-1 must be idle.
    const last = [...driverEvents].toReversed().find((e) => e.ptyId === 'pty-1')
    expect(last?.driver).toEqual({ kind: 'idle' })
  })
})

describe('mobile presence lock — multi-mobile semantics', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('elects one query responder and promotes the survivor on unsubscribe', async () => {
    const { runtime } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    await runtime.handleMobileSubscribe('pty-1', 'phone-B', { cols: 38, rows: 18 })

    expect(runtime.isMobileTerminalQueryReplyAuthority('pty-1', 'phone-A')).toBe(true)
    expect(runtime.isMobileTerminalQueryReplyAuthority('pty-1', 'phone-B')).toBe(false)

    runtime.handleMobileUnsubscribe('pty-1', 'phone-A')
    expect(runtime.isMobileTerminalQueryReplyAuthority('pty-1', 'phone-B')).toBe(true)

    await runtime.reclaimTerminalForDesktop('pty-1')
    expect(runtime.isMobileTerminalQueryReplyAuthority('pty-1', 'phone-B')).toBe(false)
  })

  it('keeps the earliest subscriber authoritative after a soft-leave resubscribe', async () => {
    const { runtime } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    runtime.handleMobileUnsubscribe('pty-1', 'phone-A')

    await vi.advanceTimersByTimeAsync(10)
    await runtime.handleMobileSubscribe('pty-1', 'phone-B', { cols: 38, rows: 18 })
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })

    expect(runtime.isMobileTerminalQueryReplyAuthority('pty-1', 'phone-A')).toBe(true)
    expect(runtime.isMobileTerminalQueryReplyAuthority('pty-1', 'phone-B')).toBe(false)
  })

  it('excludes an older passive desktop-mode subscriber from reply authority', async () => {
    const { runtime } = createRuntime()
    runtime.setMobileDisplayMode('pty-1', 'desktop')
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    await vi.advanceTimersByTimeAsync(10)
    await runtime.handleMobileSubscribe('pty-1', 'phone-B', { cols: 38, rows: 18 })

    await vi.advanceTimersByTimeAsync(10)
    runtime.markMobileActor('pty-1', 'phone-B')
    runtime.setMobileDisplayMode('pty-1', 'auto')
    await runtime.applyMobileDisplayMode('pty-1')

    expect(runtime.isMobileTerminalQueryReplyAuthority('pty-1', 'phone-A')).toBe(false)
    expect(runtime.isMobileTerminalQueryReplyAuthority('pty-1', 'phone-B')).toBe(true)
  })

  it('most-recent actor wins active phone-fit dims (B subscribes after A)', async () => {
    const { runtime, ptySizes } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

    // Advance fake clock so B's subscribedAt is strictly greater than A's.
    await vi.advanceTimersByTimeAsync(10)
    // B's narrower viewport must win when it subscribes.
    await runtime.handleMobileSubscribe('pty-1', 'phone-B', { cols: 38, rows: 18 })

    expect(ptySizes.get('pty-1')).toEqual({ cols: 38, rows: 18 })
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-B' })
  })

  it('B unsubscribes — A still present, driver re-elects to A', async () => {
    const { runtime, driverEvents } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    await vi.advanceTimersByTimeAsync(10)
    await runtime.handleMobileSubscribe('pty-1', 'phone-B', { cols: 38, rows: 18 })

    runtime.handleMobileUnsubscribe('pty-1', 'phone-B')

    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
    expect(driverEvents.at(-1)?.driver).toEqual({ kind: 'mobile', clientId: 'phone-A' })
  })

  it('A then B unsubscribes — peer survives; final unsubscribe goes idle', async () => {
    const { runtime } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    await vi.advanceTimersByTimeAsync(10)
    await runtime.handleMobileSubscribe('pty-1', 'phone-B', { cols: 38, rows: 18 })

    runtime.handleMobileUnsubscribe('pty-1', 'phone-A')
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-B' })

    runtime.handleMobileUnsubscribe('pty-1', 'phone-B')
    // Last leaver enters soft-grace; advance past it before asserting idle.
    await vi.advanceTimersByTimeAsync(250)
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })
  })

  it('terminal.send by phone-B updates lastActedAt — applyMobileDisplayMode picks B viewport', async () => {
    const { runtime, ptySizes } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    // Advance so phone-B's subscribe records a strictly later timestamp — keeps tie-break deterministic.
    await vi.advanceTimersByTimeAsync(10)
    await runtime.handleMobileSubscribe('pty-1', 'phone-B', { cols: 38, rows: 18 })
    // Switch to desktop, then phone-B types — its viewport wins on re-fit.
    runtime.setMobileDisplayMode('pty-1', 'desktop')
    await runtime.applyMobileDisplayMode('pty-1')
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })

    // Advance so B's lastActedAt is unambiguously the most recent before it takes the floor.
    await vi.advanceTimersByTimeAsync(10)
    await runtime.mobileTookFloor('pty-1', 'phone-B')

    expect(ptySizes.get('pty-1')).toEqual({ cols: 38, rows: 18 })
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-B' })
  })

  it('mobile mode change marks the caller before applying phone-fit', async () => {
    const { runtime, ptySizes } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    await vi.advanceTimersByTimeAsync(10)
    await runtime.handleMobileSubscribe('pty-1', 'phone-B', { cols: 38, rows: 18 })

    runtime.setMobileDisplayMode('pty-1', 'desktop')
    await runtime.applyMobileDisplayMode('pty-1')
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })

    await vi.advanceTimersByTimeAsync(10)
    runtime.markMobileActor('pty-1', 'phone-B')
    runtime.setMobileDisplayMode('pty-1', 'auto')
    await runtime.applyMobileDisplayMode('pty-1')

    expect(ptySizes.get('pty-1')).toEqual({ cols: 38, rows: 18 })
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-B' })
  })

  it('updateMobileViewport re-fits PTY without flipping the driver', async () => {
    const { runtime, ptySizes, driverEvents, fitOverrideEvents } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 49, rows: 38 })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 49, rows: 38 })
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
    const before = driverEvents.length
    const fitEventsBefore = fitOverrideEvents.length

    // Keyboard opens — viewport shrinks.
    await expect(
      runtime.updateMobileViewport('pty-1', 'phone-A', { cols: 49, rows: 16 })
    ).resolves.toEqual({ updated: true, applied: true })

    expect(ptySizes.get('pty-1')).toEqual({ cols: 49, rows: 16 })
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
    // Why: a viewport update may re-emit driver but must never pass through idle (no banner flash).
    expect(driverEvents.slice(before).every((e) => e.driver.kind === 'mobile')).toBe(true)
    // Why: phone→phone dim ticks (keyboard show/hide) are the hottest path — must not wake fit-override listeners (gate opens only on layout-kind/override-presence change).
    expect(fitOverrideEvents.length).toBe(fitEventsBefore)
  })

  it('updateMobileViewport late-binds a viewport-less mobile subscriber', async () => {
    const { runtime, ptySizes } = createRuntime()

    expect(await runtime.handleMobileSubscribe('pty-1', 'phone-A')).toBe(false)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })

    await expect(
      runtime.updateMobileViewport('pty-1', 'phone-A', { cols: 49, rows: 16 })
    ).resolves.toEqual({ updated: true, applied: true })

    expect(ptySizes.get('pty-1')).toEqual({ cols: 49, rows: 16 })
    expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
  })

  it('updateDesktopViewport resizes the source PTY and records desktop geometry', async () => {
    const { runtime, ptySizes, resizes } = createRuntime()

    expect(await runtime.updateDesktopViewport('pty-1', { cols: 132, rows: 44 })).toBe(true)

    expect(ptySizes.get('pty-1')).toEqual({ cols: 132, rows: 44 })
    expect(resizes.at(-1)).toEqual({ ptyId: 'pty-1', cols: 132, rows: 44 })
    expect(runtime.getLastRendererSize('pty-1')).toEqual({ cols: 132, rows: 44 })
  })

  it('updateMobileViewport records viewport without applying layout in desktop mode', async () => {
    const { runtime, ptySizes } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 49, rows: 38 })
    runtime.setMobileDisplayMode('pty-1', 'desktop')
    await runtime.applyMobileDisplayMode('pty-1')

    await expect(
      runtime.updateMobileViewport('pty-1', 'phone-A', { cols: 49, rows: 16 })
    ).resolves.toEqual({ updated: true, applied: false })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
  })

  it('updateMobileViewport reports applied=false when phone-fit resize fails', async () => {
    const { runtime, ptySizes, setResizeSucceeds } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 49, rows: 38 })
    setResizeSucceeds(false)

    await expect(
      runtime.updateMobileViewport('pty-1', 'phone-A', { cols: 49, rows: 16 })
    ).resolves.toEqual({ updated: true, applied: false })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 49, rows: 38 })
  })

  it('updateDesktopViewport records geometry without resizing while mobile is driving', async () => {
    const { runtime, ptySizes, resizes } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 49, rows: 20 })
    resizes.length = 0

    expect(await runtime.updateDesktopViewport('pty-1', { cols: 132, rows: 44 })).toBe(true)

    expect(ptySizes.get('pty-1')).toEqual({ cols: 49, rows: 20 })
    expect(resizes).toEqual([])
    expect(runtime.getLastRendererSize('pty-1')).toEqual({ cols: 132, rows: 44 })
  })

  it('updateDesktopViewport records restore geometry while phone-fit override is held', async () => {
    const { runtime, ptySizes, resizes } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 49, rows: 20 })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 49, rows: 20 })
    resizes.length = 0

    expect(await runtime.updateDesktopViewport('pty-1', { cols: 132, rows: 44 })).toBe(true)

    expect(ptySizes.get('pty-1')).toEqual({ cols: 49, rows: 20 })
    expect(resizes).toEqual([])
    expect(runtime.getLastRendererSize('pty-1')).toEqual({ cols: 132, rows: 44 })

    expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 132, rows: 44 })
  })

  it('updateMobileViewport then disconnect restores PTY to original baseline', async () => {
    const { runtime, ptySizes } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 49, rows: 38 })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 49, rows: 38 })

    // Keyboard cycles a few times.
    await runtime.updateMobileViewport('pty-1', 'phone-A', { cols: 49, rows: 16 })
    await runtime.updateMobileViewport('pty-1', 'phone-A', { cols: 49, rows: 38 })
    await runtime.updateMobileViewport('pty-1', 'phone-A', { cols: 49, rows: 16 })

    // Phone disconnects (router.back → WS close).
    runtime.onClientDisconnected('phone-A')
    // onClientDisconnected enqueues fire-and-forget; flush microtasks + 0ms timers.
    await vi.advanceTimersByTimeAsync(0)

    // Must restore to the original 150x40 baseline, not the last phone-fit dim (the stuck-dim bug).
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })
  })

  it('legacy unsubscribe → resubscribe within grace preserves baseline (regression)', async () => {
    const { runtime, ptySizes } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 49, rows: 38 })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 49, rows: 38 })

    // Simulate legacy keyboard re-subscribe cycle within grace.
    runtime.handleMobileUnsubscribe('pty-1', 'phone-A')
    await vi.advanceTimersByTimeAsync(100)
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 49, rows: 16 })
    // Apply mode after re-subscribe so the new viewport drives PTY dims.
    await runtime.applyMobileDisplayMode('pty-1')

    // PTY at new viewport, phone-A still drives.
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })

    // Disconnect — must restore to original 150x40, not 49x16.
    runtime.onClientDisconnected('phone-A')
    await vi.advanceTimersByTimeAsync(0)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
  })

  it('earliest-subscribe restore target is preserved when peers churn', async () => {
    const { runtime, ptySizes } = createRuntime()
    // A captures the original 150x40 baseline.
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    // B subscribes later at 38x18 (advance clock for unambiguous ordering).
    await vi.advanceTimersByTimeAsync(10)
    await runtime.handleMobileSubscribe('pty-1', 'phone-B', { cols: 38, rows: 18 })

    // Final restore must use A's earliest baseline (150x40), not B's (it captured 45x20 joining a phone-fitted PTY).
    runtime.handleMobileUnsubscribe('pty-1', 'phone-A')
    runtime.handleMobileUnsubscribe('pty-1', 'phone-B')
    await vi.advanceTimersByTimeAsync(5_000)

    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
  })
})

// Why (#7588): reproduce the held-modal state — a null-viewport resubscribe re-registers an active subscriber while the phone-fit override is still held (where Restore used to no-op).
async function reachHeldModalWithNullViewportResubscribe(
  runtime: OrcaRuntimeService
): Promise<void> {
  await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
  runtime.handleMobileUnsubscribe('pty-1', 'phone-A')
  await vi.advanceTimersByTimeAsync(300)
  // Production RPC passes params.viewport straight through, so an unmeasured client arrives as undefined.
  await runtime.handleMobileSubscribe('pty-1', 'phone-A', undefined)
}

describe('mobile presence lock — issue #7588 held-modal restore convergence', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // Scenario 1: reported repro end-to-end — restore must notify both channels since remote/web viewers ride the listener channel.
  it('reclaim after a null-viewport resubscribe restores dims, clears override, notifies both channels', async () => {
    const { runtime, ptySizes, fitOverrideEvents } = createRuntime(null)
    const listenerEvents: { mode: string; cols: number; rows: number }[] = []
    runtime.subscribeToFitOverrideChanges('pty-1', (e) => listenerEvents.push(e))

    await reachHeldModalWithNullViewportResubscribe(runtime)
    // Held state: driver idle, override still present, phone-sized PTY.
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })
    expect(runtime.getTerminalFitOverride('pty-1')).not.toBeNull()
    expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

    const notifierBefore = fitOverrideEvents.length
    const listenerBefore = listenerEvents.length
    const restored = await runtime.reclaimTerminalForDesktop('pty-1')

    expect(restored).toBe(true)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    expect(runtime.getTerminalFitOverride('pty-1')).toBeNull()
    expect(fitOverrideEvents.slice(notifierBefore).some((e) => e.mode === 'desktop-fit')).toBe(true)
    expect(listenerEvents.slice(listenerBefore).some((e) => e.mode === 'desktop-fit')).toBe(true)
  })

  // Scenario 2: second reclaim is an idempotent no-op — the persistent null-viewport subscriber keeps it in the active-subscriber branch (benign mode-change notify OK).
  it('second Restore click after success returns true with no new resize or fit-override event', async () => {
    const { runtime, resizes, fitOverrideEvents } = createRuntime(null)
    const listenerEvents: { mode: string; cols: number; rows: number }[] = []
    runtime.subscribeToFitOverrideChanges('pty-1', (e) => listenerEvents.push(e))

    await reachHeldModalWithNullViewportResubscribe(runtime)
    expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)

    const resizeCount = resizes.length
    const notifierCount = fitOverrideEvents.length
    const listenerCount = listenerEvents.length

    expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)
    expect(resizes.length).toBe(resizeCount)
    expect(fitOverrideEvents.length).toBe(notifierCount)
    expect(listenerEvents.length).toBe(listenerCount)
  })

  // Scenario 3: regression guard — an actively-driving phone (wasResizedToPhone=true) still converges to desktop.
  it('driving take-back still converges: driver → desktop, override cleared, both channels notified', async () => {
    const { runtime, ptySizes, fitOverrideEvents } = createRuntime()
    const listenerEvents: { mode: string; cols: number; rows: number }[] = []
    runtime.subscribeToFitOverrideChanges('pty-1', (e) => listenerEvents.push(e))

    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    expect(runtime.getDriver('pty-1').kind).toBe('mobile')
    expect(runtime.getTerminalFitOverride('pty-1')).not.toBeNull()

    const restored = await runtime.reclaimTerminalForDesktop('pty-1')

    expect(restored).toBe(true)
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'desktop' })
    expect(runtime.getTerminalFitOverride('pty-1')).toBeNull()
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    expect(fitOverrideEvents.some((e) => e.mode === 'desktop-fit')).toBe(true)
    expect(listenerEvents.some((e) => e.mode === 'desktop-fit')).toBe(true)
  })

  // Scenario 4: explicit held-override take-back always releases, even on failed resize — overrides #7588's keep-lock rule (which still governs the auto-restore/phone paths).
  it('held restore with a failing resize still releases and clears the override', async () => {
    const { runtime, fitOverrideEvents, setResizeSucceeds } = createRuntime(null)
    const listenerEvents: { mode: string; cols: number; rows: number }[] = []
    runtime.subscribeToFitOverrideChanges('pty-1', (e) => listenerEvents.push(e))

    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    // Last leaver under indefinite hold → override held, no active subscriber.
    runtime.handleMobileUnsubscribe('pty-1', 'phone-A')
    await vi.advanceTimersByTimeAsync(300)
    expect(runtime.isMobileSubscriberActive('pty-1')).toBe(false)
    expect(runtime.getTerminalFitOverride('pty-1')).not.toBeNull()

    const notifierBefore = fitOverrideEvents.length
    const listenerBefore = listenerEvents.length
    setResizeSucceeds(false)

    const restored = await runtime.reclaimTerminalForDesktop('pty-1')

    expect(restored).toBe(true)
    expect(runtime.getTerminalFitOverride('pty-1')).toBeNull()
    expect(fitOverrideEvents.slice(notifierBefore).some((e) => e.mode === 'desktop-fit')).toBe(true)
    expect(listenerEvents.slice(listenerBefore).some((e) => e.mode === 'desktop-fit')).toBe(true)
  })

  // Scenario 5: "take back all terminals" guarantee — an active-subscriber take-back with a failing resize must still release so a background PTY can't strand its banner.
  it('active-subscriber take-back with a failing resize still releases the lock', async () => {
    const { runtime, fitOverrideEvents, setResizeSucceeds } = createRuntime()
    const listenerEvents: { mode: string; cols: number; rows: number }[] = []
    runtime.subscribeToFitOverrideChanges('pty-1', (e) => listenerEvents.push(e))

    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })

    const notifierBefore = fitOverrideEvents.length
    const listenerBefore = listenerEvents.length
    setResizeSucceeds(false)

    const restored = await runtime.reclaimTerminalForDesktop('pty-1')

    expect(restored).toBe(true)
    // Lock released and banner dismissed despite the failed resize.
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'desktop' })
    expect(runtime.getTerminalFitOverride('pty-1')).toBeNull()
    expect(runtime.getMobileDisplayMode('pty-1')).toBe('auto')
    expect(fitOverrideEvents.slice(notifierBefore).some((e) => e.mode === 'desktop-fit')).toBe(true)
    expect(listenerEvents.slice(listenerBefore).some((e) => e.mode === 'desktop-fit')).toBe(true)
  })

  // Scenario 5b: explicit take-back releases unconditionally (pre-revision kept the lock for a later auto-restore).
  it('failed take-back leaves no stranded override or lock', async () => {
    const { runtime, setResizeSucceeds } = createRuntime()

    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })

    setResizeSucceeds(false)
    expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)

    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'desktop' })
    expect(runtime.getTerminalFitOverride('pty-1')).toBeNull()
    expect(runtime.getMobileDisplayMode('pty-1')).toBe('auto')
  })

  // Scenario 6: phone-initiated desktop switch converges a stale held override via the shared applyMobileDisplayMode seam.
  it('phone-initiated setDisplayMode(desktop) against a stale held override converges', async () => {
    const { runtime, ptySizes, fitOverrideEvents } = createRuntime(null)
    const listenerEvents: { mode: string; cols: number; rows: number }[] = []
    runtime.subscribeToFitOverrideChanges('pty-1', (e) => listenerEvents.push(e))

    await reachHeldModalWithNullViewportResubscribe(runtime)
    expect(runtime.getTerminalFitOverride('pty-1')).not.toBeNull()

    const notifierBefore = fitOverrideEvents.length
    const listenerBefore = listenerEvents.length

    runtime.setMobileDisplayMode('pty-1', 'desktop')
    const converged = await runtime.applyMobileDisplayMode('pty-1')

    expect(converged).toBe(true)
    expect(runtime.getTerminalFitOverride('pty-1')).toBeNull()
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    expect(fitOverrideEvents.slice(notifierBefore).some((e) => e.mode === 'desktop-fit')).toBe(true)
    expect(listenerEvents.slice(listenerBefore).some((e) => e.mode === 'desktop-fit')).toBe(true)
  })

  // Scenario 7 (white-box): a held override with no `layouts` entry is unreachable via public APIs (onPtyExit deletes both in lockstep), so seed it directly.
  it('orphan cleanup: reclaim on a held override with no layout entry converges', async () => {
    const { runtime, fitOverrideEvents } = createRuntime(null)
    const listenerEvents: { mode: string; cols: number; rows: number }[] = []
    runtime.subscribeToFitOverrideChanges('pty-1', (e) => listenerEvents.push(e))

    const internal = runtime as unknown as {
      terminalFitOverrides: Map<
        string,
        {
          mode: string
          cols: number
          rows: number
          previousCols: number | null
          previousRows: number | null
          updatedAt: number
          clientId: string
        }
      >
    }
    internal.terminalFitOverrides.set('pty-1', {
      mode: 'mobile-fit',
      cols: 45,
      rows: 20,
      previousCols: 150,
      previousRows: 40,
      updatedAt: Date.now(),
      clientId: 'phone-A'
    })
    expect(runtime.getTerminalFitOverride('pty-1')).not.toBeNull()

    const restored = await runtime.reclaimTerminalForDesktop('pty-1')

    expect(restored).toBe(true)
    expect(runtime.getTerminalFitOverride('pty-1')).toBeNull()
    expect(fitOverrideEvents.find((e) => e.mode === 'desktop-fit')).toEqual({
      ptyId: 'pty-1',
      mode: 'desktop-fit',
      cols: 0,
      rows: 0
    })
    expect(listenerEvents.find((e) => e.mode === 'desktop-fit')).toEqual({
      mode: 'desktop-fit',
      cols: 0,
      rows: 0
    })
  })
})
