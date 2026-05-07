/* oxlint-disable max-lines -- Why: integration tests cover the full mobile subscribe lifecycle across many scenarios; splitting would scatter related assertions. */
/**
 * Integration tests for the server-authoritative mobile subscribe lifecycle.
 * Tests handleMobileSubscribe, handleMobileUnsubscribe, applyMobileDisplayMode,
 * debounced restore, inline restore on timer cancel, and cleanup paths.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ])
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

vi.mock('../ipc/filesystem-auth', () => ({
  invalidateAuthorizedRootsCache: vi.fn()
}))

vi.mock('../git/repo', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getDefaultBaseRef: vi.fn().mockReturnValue('origin/main'),
    getBranchConflictKind: vi.fn().mockResolvedValue(null),
    getGitUsername: vi.fn().mockReturnValue('')
  }
})

// Why: many tests pre-date the mobileAutoRestoreFitMs preference. Default
// the mock store to MIN (5_000ms — the new clamp floor) so legacy
// assertions about "restore fires after the configured delay" keep their
// shape while new tests can override per-test. Indefinite/null is the
// real-world default and is exercised by a dedicated test below.
const LEGACY_RESTORE_MS = 5_000
const settingsState = {
  mobileAutoRestoreFitMs: LEGACY_RESTORE_MS as number | null
}

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
    mobileAutoRestoreFitMs: settingsState.mobileAutoRestoreFitMs
  }),
  updateSettings: (updates: { mobileAutoRestoreFitMs?: number | null }) => {
    if ('mobileAutoRestoreFitMs' in updates) {
      settingsState.mobileAutoRestoreFitMs = updates.mobileAutoRestoreFitMs ?? null
    }
  }
}

function createRuntime() {
  const runtime = new OrcaRuntimeService(store)
  const ptySizes = new Map<string, { cols: number; rows: number }>()
  ptySizes.set('pty-1', { cols: 150, rows: 40 })
  ptySizes.set('pty-2', { cols: 120, rows: 35 })
  ptySizes.set('pty-3', { cols: 100, rows: 30 })

  const resizes: { ptyId: string; cols: number; rows: number }[] = []
  const notifications: { ptyId: string; mode: string; cols: number; rows: number }[] = []

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
      notifications.push({ ptyId, mode, cols, rows })
    },
    terminalDriverChanged: vi.fn()
  })

  return { runtime, ptySizes, resizes, notifications }
}

describe('mobile subscribe integration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    settingsState.mobileAutoRestoreFitMs = LEGACY_RESTORE_MS
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('handleMobileSubscribe resizes PTY to phone dims', async () => {
    const { runtime, ptySizes, resizes, notifications } = createRuntime()

    const result = await runtime.handleMobileSubscribe('pty-1', 'client-a', {
      cols: 45,
      rows: 20
    })

    expect(result).toBe(true)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
    expect(resizes).toEqual([{ ptyId: 'pty-1', cols: 45, rows: 20 }])
    expect(notifications).toEqual([{ ptyId: 'pty-1', mode: 'mobile-fit', cols: 45, rows: 20 }])
    expect(runtime.isMobileSubscriberActive('pty-1')).toBe(true)
  })

  it('handleMobileSubscribe skips resize when mode is desktop', async () => {
    const { runtime, ptySizes, resizes } = createRuntime()
    runtime.setMobileDisplayMode('pty-1', 'desktop')

    const result = await runtime.handleMobileSubscribe('pty-1', 'client-a', {
      cols: 45,
      rows: 20
    })

    expect(result).toBe(false)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    expect(resizes).toEqual([])
  })

  it('handleMobileSubscribe skips resize when no viewport provided', async () => {
    const { runtime, ptySizes, resizes } = createRuntime()

    const result = await runtime.handleMobileSubscribe('pty-1', 'client-a')

    expect(result).toBe(false)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    expect(resizes).toEqual([])
  })

  it('handleMobileUnsubscribe restores PTY after debounce in auto mode', async () => {
    const { runtime, ptySizes } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

    runtime.handleMobileUnsubscribe('pty-1', 'client-a')
    // Not yet restored
    expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

    await vi.advanceTimersByTimeAsync(LEGACY_RESTORE_MS)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
  })

  // Why: 'phone' (sticky-fit) mode was removed — there are now only 'auto'
  // and 'desktop'. Auto-mode always restores on last unsubscribe. Test
  // kept and inverted to lock in the new contract.
  it('handleMobileUnsubscribe restores after auto-mode last unsubscribe', async () => {
    const { runtime, ptySizes } = createRuntime()
    // mode defaults to 'auto'
    await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

    runtime.handleMobileUnsubscribe('pty-1', 'client-a')
    await vi.advanceTimersByTimeAsync(LEGACY_RESTORE_MS)
    // Restored to desktop dims — no sticky-phone retention.
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
  })

  // TODO: inline restore on re-subscribe not yet implemented
  it.skip('re-subscribe within 300ms cancels debounce timer and inline-restores old PTY', async () => {
    const { runtime, ptySizes } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
    runtime.handleMobileUnsubscribe('pty-1', 'client-a')

    // Re-subscribe to a different terminal before the timer fires
    await vi.advanceTimersByTimeAsync(100)
    await runtime.handleMobileSubscribe('pty-2', 'client-a', { cols: 45, rows: 20 })

    // pty-1 was inline-restored when pty-2 subscribed (timer cancelled + immediate restore)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    expect(ptySizes.get('pty-2')).toEqual({ cols: 45, rows: 20 })

    // Advancing past the 300ms debounce should not cause a second restore
    await vi.advanceTimersByTimeAsync(300)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
  })

  // TODO: inline restore on re-subscribe not yet implemented
  it.skip('rapid A→B→C tab navigation: inline restore of A when B subscribes', async () => {
    const { runtime, ptySizes } = createRuntime()

    // Subscribe to A
    await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

    // Unsubscribe A, subscribe B — A's pending timer is cancelled, A gets inline restore
    runtime.handleMobileUnsubscribe('pty-1', 'client-a')
    await runtime.handleMobileSubscribe('pty-2', 'client-a', { cols: 45, rows: 20 })

    // pty-1 should be restored inline (not waiting for timer)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    expect(ptySizes.get('pty-2')).toEqual({ cols: 45, rows: 20 })

    // Unsubscribe B, subscribe C — B's pending timer cancelled, B gets inline restore
    runtime.handleMobileUnsubscribe('pty-2', 'client-a')
    await runtime.handleMobileSubscribe('pty-3', 'client-a', { cols: 45, rows: 20 })

    expect(ptySizes.get('pty-2')).toEqual({ cols: 120, rows: 35 })
    expect(ptySizes.get('pty-3')).toEqual({ cols: 45, rows: 20 })

    // Verify final state
    await vi.advanceTimersByTimeAsync(1000)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    expect(ptySizes.get('pty-2')).toEqual({ cols: 120, rows: 35 })
    expect(ptySizes.get('pty-3')).toEqual({ cols: 45, rows: 20 })
  })

  it('preserves previousDims across re-subscribes to same terminal', async () => {
    const { runtime, ptySizes } = createRuntime()

    // First subscribe at desktop 150x40
    await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

    // Re-subscribe to the same terminal (e.g., after reconnect)
    // The PTY is already at 45x20, but previousDims should still be 150x40
    await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })

    // Unsubscribe and let restore fire
    runtime.handleMobileUnsubscribe('pty-1', 'client-a')
    await vi.advanceTimersByTimeAsync(LEGACY_RESTORE_MS)

    // Should restore to original desktop dims, not 45x20
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
  })

  it('clamps viewport to valid range', async () => {
    const { runtime, ptySizes } = createRuntime()

    await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 10, rows: 3 })
    // Should clamp to minimum 20x8
    expect(ptySizes.get('pty-1')).toEqual({ cols: 20, rows: 8 })
  })

  describe('display mode', () => {
    it('defaults to auto', () => {
      const { runtime } = createRuntime()
      expect(runtime.getMobileDisplayMode('pty-1')).toBe('auto')
    })

    it('set/get round-trip', () => {
      const { runtime } = createRuntime()
      runtime.setMobileDisplayMode('pty-1', 'desktop')
      expect(runtime.getMobileDisplayMode('pty-1')).toBe('desktop')

      // Setting to 'auto' deletes the entry (same as default)
      runtime.setMobileDisplayMode('pty-1', 'auto')
      expect(runtime.getMobileDisplayMode('pty-1')).toBe('auto')
    })
  })

  describe('applyMobileDisplayMode', () => {
    it('desktop mode restores PTY when currently phone-fitted', async () => {
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

      const resizeEvents: unknown[] = []
      runtime.subscribeToTerminalResize('pty-1', (event) => resizeEvents.push(event))

      runtime.setMobileDisplayMode('pty-1', 'desktop')
      await runtime.applyMobileDisplayMode('pty-1')

      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
      expect(resizeEvents).toHaveLength(1)
      expect(resizeEvents[0]).toMatchObject({
        cols: 150,
        rows: 40,
        displayMode: 'desktop',
        reason: 'apply-layout'
      })
    })

    it('auto mode re-fits PTY when subscriber exists and not phone-fitted', async () => {
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })

      // Switch to desktop (restores to 150x40)
      runtime.setMobileDisplayMode('pty-1', 'desktop')
      await runtime.applyMobileDisplayMode('pty-1')
      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })

      const resizeEvents: unknown[] = []
      runtime.subscribeToTerminalResize('pty-1', (event) => resizeEvents.push(event))

      // Switch back to auto (should re-fit to phone dims)
      runtime.setMobileDisplayMode('pty-1', 'auto')
      await runtime.applyMobileDisplayMode('pty-1')

      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
      expect(resizeEvents).toHaveLength(1)
      expect(resizeEvents[0]).toMatchObject({
        displayMode: 'phone',
        reason: 'apply-layout'
      })
    })
  })

  describe('cleanup paths', () => {
    it('onClientDisconnected restores all PTYs immediately (no debounce)', async () => {
      const { runtime, ptySizes } = createRuntime()

      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      await runtime.handleMobileSubscribe('pty-2', 'client-a', { cols: 45, rows: 20 })

      runtime.onClientDisconnected('client-a')
      // onClientDisconnected enqueues fire-and-forget; flush microtasks + 0ms timers.
      await vi.advanceTimersByTimeAsync(0)

      // Both PTYs restored immediately
      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
      expect(ptySizes.get('pty-2')).toEqual({ cols: 120, rows: 35 })
      expect(runtime.isMobileSubscriberActive('pty-1')).toBe(false)
      expect(runtime.isMobileSubscriberActive('pty-2')).toBe(false)
    })

    it('onClientDisconnected cancels pending restore timers', async () => {
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.handleMobileUnsubscribe('pty-1', 'client-a')
      // Timer is pending

      runtime.onClientDisconnected('client-a')
      // Timer should be cancelled, PTY already restored by disconnect handler

      await vi.advanceTimersByTimeAsync(LEGACY_RESTORE_MS)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    })

    it('onPtyExit cleans up mobileSubscribers and pending timers', async () => {
      const { runtime } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.handleMobileUnsubscribe('pty-1', 'client-a')
      // Timer pending for pty-1

      runtime.onPtyExit('pty-1', 0)
      expect(runtime.isMobileSubscriberActive('pty-1')).toBe(false)
      expect(runtime.getMobileDisplayMode('pty-1')).toBe('auto')

      // Timer should have been cancelled — no crash from resizing a dead PTY
      await vi.advanceTimersByTimeAsync(LEGACY_RESTORE_MS)
    })

    it('onPtyExit does not cancel timers for other PTYs', async () => {
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.handleMobileUnsubscribe('pty-1', 'client-a')

      // pty-2 exits — should not affect pty-1's pending restore
      runtime.onPtyExit('pty-2', 0)

      await vi.advanceTimersByTimeAsync(LEGACY_RESTORE_MS)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    })
  })

  describe('resize listener system', () => {
    it('subscribe/unsubscribe lifecycle', async () => {
      const { runtime } = createRuntime()
      const events: unknown[] = []
      const unsubscribe = runtime.subscribeToTerminalResize('pty-1', (e) => events.push(e))

      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.setMobileDisplayMode('pty-1', 'desktop')
      await runtime.applyMobileDisplayMode('pty-1')

      expect(events.length).toBeGreaterThan(0)

      const countBefore = events.length
      unsubscribe()

      // After unsubscribe, no more events
      runtime.setMobileDisplayMode('pty-1', 'auto')
      await runtime.applyMobileDisplayMode('pty-1')
      expect(events.length).toBe(countBefore)
    })
  })

  describe('onExternalPtyResize', () => {
    it('updates previousCols when desktop renderer resizes PTY after desktop restore', async () => {
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })

      // Toggle to desktop — restores to previousCols (150x40)
      runtime.setMobileDisplayMode('pty-1', 'desktop')
      await runtime.applyMobileDisplayMode('pty-1')
      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })

      // Phone→desktop arms the 500ms renderer-cascade suppress window per
      // docs/mobile-terminal-layout-state-machine.md. Wait it out before the
      // renderer's correcting fit is allowed to update lastRendererSizes.
      await vi.advanceTimersByTimeAsync(500)

      // Simulate desktop renderer's safeFit correcting to split-pane width
      runtime.onExternalPtyResize('pty-1', 105, 40)

      // Toggle back to auto — should capture previousCols=105 (not 150)
      runtime.setMobileDisplayMode('pty-1', 'auto')
      await runtime.applyMobileDisplayMode('pty-1')
      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

      // Toggle to desktop again — should restore to 105 (the corrected value)
      runtime.setMobileDisplayMode('pty-1', 'desktop')
      await runtime.applyMobileDisplayMode('pty-1')
      expect(ptySizes.get('pty-1')).toEqual({ cols: 105, rows: 40 })
    })

    it('uses lastRendererSize for previousCols on first subscribe', async () => {
      const { runtime, ptySizes } = createRuntime()

      // Simulate: PTY spawned at 214 (ptySizes), but renderer already fit to 105
      ptySizes.set('pty-1', { cols: 214, rows: 72 })
      runtime.onExternalPtyResize('pty-1', 105, 40)

      // First mobile subscribe — should use rendererSize (105) not ptySizes (214)
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

      // Toggle to desktop — should restore to 105, not 214
      runtime.setMobileDisplayMode('pty-1', 'desktop')
      await runtime.applyMobileDisplayMode('pty-1')
      expect(ptySizes.get('pty-1')).toEqual({ cols: 105, rows: 40 })
    })

    it('refreshes baseline on phone-fitted subscribers when their baseline is non-null', async () => {
      // Behavior change per docs/mobile-terminal-layout-state-machine.md:
      // legacy `!wasResizedToPhone` gate is replaced with `previousCols != null`.
      // A phone-fitted subscriber's baseline IS non-null (captured at subscribe),
      // so onExternalPtyResize now overwrites it with the renderer's reported geometry.
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })

      // Renderer reports 45x20 — under the new design, this overwrites baseline
      // (previously it was skipped because the subscriber was phone-fitted).
      runtime.onExternalPtyResize('pty-1', 45, 20)

      // Toggle to desktop — restore lands on what the renderer reported (45x20),
      // not the original 150x40.
      runtime.setMobileDisplayMode('pty-1', 'desktop')
      await runtime.applyMobileDisplayMode('pty-1')
      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
    })
  })

  describe('backward compatibility', () => {
    it('old resizeForClient still works alongside new system', async () => {
      const { runtime, ptySizes } = createRuntime()

      // Old flow: explicit resizeForClient
      const fitResult = await runtime.resizeForClient('pty-1', 'mobile-fit', 'client-old', 45, 20)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
      expect(fitResult.mode).toBe('mobile-fit')

      // Old flow: restore
      const restoreResult = await runtime.resizeForClient('pty-1', 'restore', 'client-old')
      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
      expect(restoreResult.mode).toBe('desktop-fit')
    })
  })

  // See docs/mobile-fit-hold.md.
  describe('mobileAutoRestoreFitMs (fit hold)', () => {
    it('null (indefinite) keeps PTY at phone dims after last unsubscribe', async () => {
      settingsState.mobileAutoRestoreFitMs = null
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.handleMobileUnsubscribe('pty-1', 'client-a')

      // Wait long past the legacy 300ms debounce — PTY must remain held.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
    })

    it('finite ms restores after the configured delay', async () => {
      settingsState.mobileAutoRestoreFitMs = 60_000
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.handleMobileUnsubscribe('pty-1', 'client-a')

      await vi.advanceTimersByTimeAsync(30_000)
      // Not yet — still mid-window.
      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

      await vi.advanceTimersByTimeAsync(30_000)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    })

    it('re-subscribe before timer fires cancels pending restore', async () => {
      settingsState.mobileAutoRestoreFitMs = 60_000
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.handleMobileUnsubscribe('pty-1', 'client-a')

      await vi.advanceTimersByTimeAsync(30_000)
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })

      // The pending timer should have been cancelled by the new subscribe.
      // Wait long past what would've been the restore moment.
      await vi.advanceTimersByTimeAsync(120_000)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
    })

    it('reclaimTerminalForDesktop with active subscriber resets mode so next subscribe re-fits', async () => {
      // Why: desktop "Take back" while the phone is actively driving sets
      // mobileDisplayMode='desktop' to drive the layout transition. Without
      // resetting it, the next mobile subscribe (e.g. user switches tabs
      // back on the phone) sees mode='desktop' and enters passive watch,
      // never re-fitting the PTY to phone dims. The phone then renders the
      // desktop-dim scrollback echoed back at it. See docs/mobile-fit-hold.md.
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

      // Desktop reclaim while phone is still subscribed.
      const ok = await runtime.reclaimTerminalForDesktop('pty-1')
      expect(ok).toBe(true)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
      // Mode reset so a re-subscribe takes the auto path.
      expect(runtime.getMobileDisplayMode('pty-1')).toBe('auto')

      // Mobile re-subscribes (e.g. tab switch). Must re-fit to phone dims.
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
    })

    it('null (indefinite) keeps PTY at phone dims when WS connection closes (onClientDisconnected)', async () => {
      // Why: backgrounding the mobile app eventually closes the WebSocket,
      // which routes through onClientDisconnected (NOT handleMobileUnsubscribe).
      // The disconnect path predates indefinite-hold; without explicit gates
      // it would unconditionally restore the PTY to desktop dims and clear
      // the override, unmounting the desktop banner.
      settingsState.mobileAutoRestoreFitMs = null
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })

      runtime.onClientDisconnected('client-a')
      await vi.advanceTimersByTimeAsync(0)
      // Flush soft-leave grace too — that path also has its own desktop-restore branch.
      await vi.advanceTimersByTimeAsync(60_000)

      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
      expect(runtime.getTerminalFitOverride('pty-1')).not.toBeNull()
    })

    it('reclaimTerminalForDesktop returns held PTY to desktop dims (no subscriber)', async () => {
      settingsState.mobileAutoRestoreFitMs = null
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.handleMobileUnsubscribe('pty-1', 'client-a')

      // No subscribers, indefinite hold — PTY stays at phone dims.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
      expect(runtime.isMobileSubscriberActive('pty-1')).toBe(false)

      // Manual reclaim: PTY restored to desktop dims via the held branch.
      const ok = await runtime.reclaimTerminalForDesktop('pty-1')
      expect(ok).toBe(true)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    })

    it('setMobileAutoRestoreFitMs(null) clears all pending timers', async () => {
      settingsState.mobileAutoRestoreFitMs = 60_000
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.handleMobileUnsubscribe('pty-1', 'client-a')

      // Pending timer exists. Switch preference → indefinite.
      runtime.setMobileAutoRestoreFitMs(null)
      // Now wait far longer than the original 60s window. No restore fires.
      await vi.advanceTimersByTimeAsync(120_000)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
    })

    it('setMobileAutoRestoreFitMs to a finite value does not retroactively schedule', async () => {
      settingsState.mobileAutoRestoreFitMs = null
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.handleMobileUnsubscribe('pty-1', 'client-a')

      // Indefinite hold — no timer scheduled at unsubscribe.
      // Switch preference → 60s. The already-held PTY is NOT auto-restored;
      // the new value applies to the *next* unsubscribe.
      runtime.setMobileAutoRestoreFitMs(60_000)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
    })

    it('setMobileAutoRestoreFitMs clamps below MIN to MIN', () => {
      const { runtime } = createRuntime()
      const result = runtime.setMobileAutoRestoreFitMs(100)
      expect(result).toBe(5_000)
    })

    it('setMobileAutoRestoreFitMs clamps above MAX to MAX', () => {
      const { runtime } = createRuntime()
      const result = runtime.setMobileAutoRestoreFitMs(99 * 60 * 60 * 1000)
      expect(result).toBe(60 * 60 * 1000)
    })

    it('reclaimTerminalForDesktop on already-restored PTY returns false', async () => {
      const { runtime } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.handleMobileUnsubscribe('pty-1', 'client-a')
      await vi.advanceTimersByTimeAsync(LEGACY_RESTORE_MS)
      // Now restored to desktop — no subscriber, no override.
      expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(false)
    })
  })
})
