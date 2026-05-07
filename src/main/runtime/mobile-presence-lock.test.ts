/**
 * Tests for the presence-based mobile driver lock.
 *
 * Covers (per docs/mobile-presence-lock.md):
 *   - State machine transitions (idle | desktop | mobile{clientId})
 *   - Most-recent-actor wins for active phone-fit dims
 *   - Earliest-by-subscribe-time wins for desktop-restore target
 *   - Subscribe-in-desktop-mode is a passive watch (does NOT take floor)
 *   - mobileTookFloor → re-applies phone-fit when transitioning from desktop
 *   - reclaimTerminalForDesktop → idempotent, drops banner, restores dims
 *   - Multi-mobile sequencing: A subscribes / B subscribes / B unsubscribes /
 *     A unsubscribes leaves the runtime cleanly idle without dim regressions
 *   - terminalDriverChanged notifications fire at the right transitions
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([])
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
    getBranchConflictKind: vi.fn().mockResolvedValue(null),
    getGitUsername: vi.fn().mockReturnValue('')
  }
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
    branchPrefixCustom: ''
  })
}

function createRuntime() {
  const runtime = new OrcaRuntimeService(store)
  const ptySizes = new Map<string, { cols: number; rows: number }>([
    ['pty-1', { cols: 150, rows: 40 }]
  ])
  const resizes: { ptyId: string; cols: number; rows: number }[] = []
  const driverEvents: { ptyId: string; driver: { kind: string; clientId?: string } }[] = []

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
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: (ptyId, driver) => {
      driverEvents.push({ ptyId, driver: { ...driver } })
    }
  })

  return { runtime, ptySizes, resizes, driverEvents }
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

    // Driver stays idle (the desktop banner was already gone). Phone is
    // "passively watching" at desktop dims.
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })
    expect(driverEvents.find((e) => e.driver.kind === 'mobile')).toBeUndefined()
  })

  it('reclaimTerminalForDesktop transitions mobile → desktop and is idempotent', async () => {
    const { runtime } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    expect(runtime.getDriver('pty-1').kind).toBe('mobile')

    expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'desktop' })

    // Idempotent — second call is a no-op (no active mobile subscriber to
    // reclaim from).
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

  it('handleMobileUnsubscribe last leaver flips driver to idle after soft-leave grace', async () => {
    const { runtime, driverEvents } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })

    runtime.handleMobileUnsubscribe('pty-1', 'phone-A')

    // Why: soft-leave grace keeps driver=mobile{phone-A} for ~250ms so a
    // re-subscribe (e.g. mobile keyboard show/hide on legacy clients)
    // doesn't cause a desktop banner flash.
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

    // Same client re-subscribes inside the grace window — no idle should
    // ever be observed by the renderer.
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
    const last = [...driverEvents].reverse().find((e) => e.ptyId === 'pty-1')
    expect(last?.driver).toEqual({ kind: 'idle' })
  })
})

describe('mobile presence lock — multi-mobile semantics', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

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
    // Advance the fake clock so phone-B's subscribe records a strictly
    // later subscribedAt/lastActedAt — keeps tie-break deterministic.
    await vi.advanceTimersByTimeAsync(10)
    await runtime.handleMobileSubscribe('pty-1', 'phone-B', { cols: 38, rows: 18 })
    // Switch to desktop, then phone-B types — its viewport wins on re-fit.
    runtime.setMobileDisplayMode('pty-1', 'desktop')
    await runtime.applyMobileDisplayMode('pty-1')
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })

    // Simulate B taking the floor by typing (advance again so lastActedAt
    // is unambiguously the most recent).
    await vi.advanceTimersByTimeAsync(10)
    await runtime.mobileTookFloor('pty-1', 'phone-B')

    expect(ptySizes.get('pty-1')).toEqual({ cols: 38, rows: 18 })
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-B' })
  })

  it('updateMobileViewport re-fits PTY without flipping the driver', async () => {
    const { runtime, ptySizes, driverEvents } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 49, rows: 38 })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 49, rows: 38 })
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
    const before = driverEvents.length

    // Keyboard opens — viewport shrinks.
    expect(await runtime.updateMobileViewport('pty-1', 'phone-A', { cols: 49, rows: 16 })).toBe(
      true
    )

    expect(ptySizes.get('pty-1')).toEqual({ cols: 49, rows: 16 })
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
    // Why: a viewport update may re-emit driver to refresh listener
    // wiring, but it must never go through `idle` (no banner flash).
    expect(driverEvents.slice(before).every((e) => e.driver.kind === 'mobile')).toBe(true)
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

    // PTY must restore to the original 150x40 baseline, not the last
    // phone-fit dim. This was the stuck-dim bug.
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

    // A leaves, B leaves — final restore must use A's earliest baseline (150x40),
    // NOT B's (which captured 45x20 when it joined a phone-fitted PTY).
    runtime.handleMobileUnsubscribe('pty-1', 'phone-A')
    runtime.handleMobileUnsubscribe('pty-1', 'phone-B')
    await vi.advanceTimersByTimeAsync(300)

    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
  })
})
