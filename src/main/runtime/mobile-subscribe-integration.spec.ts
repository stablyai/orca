import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { listWorktrees } from '../git/worktree'
import { OrcaRuntimeService } from './orca-runtime'

// Legacy restore cases need finite 5s (the clamp floor); production defaults to indefinite hold.
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
  getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
  addRetiredWorktreeName: () => {},
  mergeRetiredWorktreeNames: () => false,
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

class ObservableRuntime extends OrcaRuntimeService {
  get restoreTimers(): typeof this.pendingRestoreTimers {
    return this.pendingRestoreTimers
  }
  get softLeavers(): typeof this.pendingSoftLeavers {
    return this.pendingSoftLeavers
  }
  get fitOverrides(): typeof this.terminalFitOverrides {
    return this.terminalFitOverrides
  }
  get drivers(): typeof this.terminalDrivers {
    return this.terminalDrivers
  }
}

function createRuntime() {
  vi.mocked(listWorktrees).mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ])
  const runtime = new ObservableRuntime(store)
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

  it('serializeMainTerminalBuffer reports the seq included in the headless snapshot', async () => {
    vi.useRealTimers()
    const { runtime } = createRuntime()
    const first = 'one\r\n'
    const second = 'two\r\n'
    const third = 'three\r\n'

    runtime.onPtyData('pty-1', first, Date.now())
    const initialSnapshot = await runtime.serializeMainTerminalBuffer('pty-1')
    expect(initialSnapshot?.seq).toBe(first.length)
    expect(initialSnapshot?.source).toBe('headless')

    type HeadlessStateForTest = {
      emulator: { write: (data: string) => Promise<void> | void }
    }
    const headless = (
      runtime as unknown as { headlessTerminals: Map<string, HeadlessStateForTest> }
    ).headlessTerminals.get('pty-1')
    expect(headless).toBeDefined()
    const originalWrite = headless!.emulator.write.bind(headless!.emulator)
    const secondWriteGate: { release: (() => void) | null } = { release: null }
    const secondWriteStarted = new Promise<void>((resolve) => {
      headless!.emulator.write = async (data: string): Promise<void> => {
        if (data === second) {
          resolve()
          await new Promise<void>((release) => {
            secondWriteGate.release = release
          })
        }
        await originalWrite(data)
      }
    })

    try {
      runtime.onPtyData('pty-1', second, Date.now())
      await secondWriteStarted
      const racedSnapshot = runtime.serializeMainTerminalBuffer('pty-1')
      runtime.onPtyData('pty-1', third, Date.now())
      if (!secondWriteGate.release) {
        throw new Error('second write did not block')
      }
      secondWriteGate.release()

      const snapshot = await racedSnapshot
      expect(snapshot?.seq).toBe(first.length + second.length)
      expect(snapshot?.source).toBe('headless')
      expect(runtime.getPtyOutputSequence('pty-1')).toBe(
        first.length + second.length + third.length
      )

      const finalSnapshot = await runtime.serializeMainTerminalBuffer('pty-1')
      expect(finalSnapshot?.seq).toBe(first.length + second.length + third.length)
      expect(finalSnapshot?.source).toBe('headless')
    } finally {
      headless!.emulator.write = originalWrite
      secondWriteGate.release?.()
    }
  })

  it('serializeMainTerminalBuffer returns an empty snapshot for an empty headless buffer', async () => {
    const { runtime } = createRuntime()
    type HeadlessStateForTest = {
      emulator: {
        isAlternateScreen: boolean
        getSnapshot: (opts: { scrollbackRows?: number }) => {
          rehydrateSequences: string
          snapshotAnsi: string
          cols: number
          rows: number
        }
      }
      outputSequence: number
      writeChain: Promise<void>
      ownership: { settle: () => Promise<void>; owner: undefined }
    }
    const runtimePrivate = runtime as unknown as {
      headlessTerminals: Map<string, HeadlessStateForTest>
    }
    runtimePrivate.headlessTerminals.set('pty-empty', {
      emulator: {
        isAlternateScreen: false,
        getSnapshot: () => ({ rehydrateSequences: '', snapshotAnsi: '', cols: 90, rows: 30 })
      },
      outputSequence: 17,
      writeChain: Promise.resolve(),
      ownership: { settle: async () => {}, owner: undefined }
    })

    await expect(runtime.serializeMainTerminalBuffer('pty-empty')).resolves.toEqual({
      data: '',
      cols: 90,
      rows: 30,
      seq: 17,
      source: 'headless',
      // Preserve destructive scrollback clear on non-alt-screen restore.
      alternateScreen: false
    })
    await expect(runtime.serializeTerminalBuffer('pty-empty')).resolves.toBeNull()
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
    expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

    await vi.advanceTimersByTimeAsync(LEGACY_RESTORE_MS)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
  })

  it('preserves previousDims across re-subscribes to same terminal', async () => {
    const { runtime, ptySizes } = createRuntime()

    await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

    // Re-subscribe sees phone-fitted PTY dims but must retain the original desktop baseline.
    await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })

    runtime.handleMobileUnsubscribe('pty-1', 'client-a')
    await vi.advanceTimersByTimeAsync(LEGACY_RESTORE_MS)

    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
  })

  it('preserves held-override baseline across resubscribe-after-indefinite-hold', async () => {
    // Indefinite-hold re-subscribe must inherit the retained desktop baseline for later Restore.
    settingsState.mobileAutoRestoreFitMs = null
    const { runtime, ptySizes } = createRuntime()

    await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

    runtime.handleMobileUnsubscribe('pty-1', 'client-a')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

    await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })

    await runtime.reclaimTerminalForDesktop('pty-1')

    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
  })

  it('clamps viewport to valid range', async () => {
    const { runtime, ptySizes } = createRuntime()

    await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 10, rows: 3 })
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

      runtime.setMobileDisplayMode('pty-1', 'desktop')
      await runtime.applyMobileDisplayMode('pty-1')
      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })

      const resizeEvents: unknown[] = []
      runtime.subscribeToTerminalResize('pty-1', (event) => resizeEvents.push(event))

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
      // Disconnect queues work; flush microtasks and zero-delay timers.
      await vi.advanceTimersByTimeAsync(0)

      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
      expect(ptySizes.get('pty-2')).toEqual({ cols: 120, rows: 35 })
      expect(runtime.isMobileSubscriberActive('pty-1')).toBe(false)
      expect(runtime.isMobileSubscriberActive('pty-2')).toBe(false)
    })

    it('onClientDisconnected cancels pending restore timers', async () => {
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.handleMobileUnsubscribe('pty-1', 'client-a')

      runtime.onClientDisconnected('client-a')

      await vi.advanceTimersByTimeAsync(LEGACY_RESTORE_MS)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    })

    it('onPtyExit cleans up mobileSubscribers and pending timers', async () => {
      const { runtime } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.handleMobileUnsubscribe('pty-1', 'client-a')

      runtime.onPtyExit('pty-1', 0)
      expect(runtime.isMobileSubscriberActive('pty-1')).toBe(false)
      expect(runtime.getMobileDisplayMode('pty-1')).toBe('auto')

      await vi.advanceTimersByTimeAsync(LEGACY_RESTORE_MS)
    })

    it('onPtyExit does not cancel timers for other PTYs', async () => {
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.handleMobileUnsubscribe('pty-1', 'client-a')

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

      runtime.setMobileDisplayMode('pty-1', 'auto')
      await runtime.applyMobileDisplayMode('pty-1')
      expect(events.length).toBe(countBefore)
    })
  })

  describe('onExternalPtyResize', () => {
    it('updates previousCols when desktop renderer resizes PTY after desktop restore', async () => {
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })

      runtime.setMobileDisplayMode('pty-1', 'desktop')
      await runtime.applyMobileDisplayMode('pty-1')
      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })

      // Wait out the 500ms phone-to-desktop resize cascade suppression before reporting renderer geometry.
      await vi.advanceTimersByTimeAsync(500)

      runtime.onExternalPtyResize('pty-1', 105, 40)

      runtime.setMobileDisplayMode('pty-1', 'auto')
      await runtime.applyMobileDisplayMode('pty-1')
      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

      runtime.setMobileDisplayMode('pty-1', 'desktop')
      await runtime.applyMobileDisplayMode('pty-1')
      expect(ptySizes.get('pty-1')).toEqual({ cols: 105, rows: 40 })
    })

    it('uses lastRendererSize for previousCols on first subscribe', async () => {
      const { runtime, ptySizes } = createRuntime()

      ptySizes.set('pty-1', { cols: 214, rows: 72 })
      runtime.onExternalPtyResize('pty-1', 105, 40)

      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

      runtime.setMobileDisplayMode('pty-1', 'desktop')
      await runtime.applyMobileDisplayMode('pty-1')
      expect(ptySizes.get('pty-1')).toEqual({ cols: 105, rows: 40 })
    })

    it('ignores reports while a mobile-fit override is in place', async () => {
      // Phone-fit echoes must not poison the desktop restore baseline; see docs/mobile-fit-hold.md.
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })

      runtime.onExternalPtyResize('pty-1', 45, 20)

      runtime.setMobileDisplayMode('pty-1', 'desktop')
      await runtime.applyMobileDisplayMode('pty-1')
      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    })

    it('still updates baseline once the override is cleared (real desktop resize)', async () => {
      // Once the override clears, legitimate renderer reports must update the baseline.
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })

      runtime.setMobileDisplayMode('pty-1', 'desktop')
      await runtime.applyMobileDisplayMode('pty-1')
      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })

      await vi.advanceTimersByTimeAsync(500)

      runtime.onExternalPtyResize('pty-1', 130, 35)

      runtime.setMobileDisplayMode('pty-1', 'auto')
      await runtime.applyMobileDisplayMode('pty-1')
      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

      runtime.setMobileDisplayMode('pty-1', 'desktop')
      await runtime.applyMobileDisplayMode('pty-1')
      expect(ptySizes.get('pty-1')).toEqual({ cols: 130, rows: 35 })
    })

    it('updates baseline mid-fit when desktop reports dims that differ from the override', async () => {
      // A newly visible desktop tab can report real geometry during phone fit; retain it for restore.
      const { runtime, ptySizes } = createRuntime()
      ptySizes.set('pty-1', { cols: 80, rows: 24 })
      runtime.onExternalPtyResize('pty-1', 80, 24)
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })

      runtime.onExternalPtyResize('pty-1', 200, 60)

      runtime.setMobileDisplayMode('pty-1', 'desktop')
      await runtime.applyMobileDisplayMode('pty-1')
      expect(ptySizes.get('pty-1')).toEqual({ cols: 200, rows: 60 })
    })
  })

  describe('recordRendererGeometry (pty:reportGeometry IPC)', () => {
    it('refreshes subscriber baseline while a mobile-fit override is active', async () => {
      // Never-active terminals need measurement-only geometry to replace spawn-default restore sizes.
      const { runtime, ptySizes } = createRuntime()
      ptySizes.set('pty-1', { cols: 80, rows: 24 })
      runtime.onExternalPtyResize('pty-1', 80, 24)
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })

      runtime.recordRendererGeometry('pty-1', 214, 72)

      runtime.setMobileDisplayMode('pty-1', 'desktop')
      await runtime.applyMobileDisplayMode('pty-1')
      expect(ptySizes.get('pty-1')).toEqual({ cols: 214, rows: 72 })
    })

    it('restores reported geometry captured before the first mobile subscribe', async () => {
      const { runtime, ptySizes, resizes } = createRuntime()
      runtime.recordRendererGeometry('pty-1', 180, 50)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
      expect(resizes).toEqual([])

      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 180, rows: 50 })
    })

    it('ignores non-positive dims when capturing restore geometry', async () => {
      const { runtime, ptySizes, resizes } = createRuntime()
      runtime.recordRendererGeometry('pty-1', 180, 50)
      runtime.recordRendererGeometry('pty-1', 0, 0)
      runtime.recordRendererGeometry('pty-1', -5, 10)
      runtime.recordRendererGeometry('pty-1', 10, -5)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
      expect(resizes).toEqual([])

      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 180, rows: 50 })
    })

    it('bypasses the cascade-suppress window (it is measurement-only)', async () => {
      const { runtime, ptySizes, resizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.setMobileDisplayMode('pty-1', 'desktop')
      await runtime.applyMobileDisplayMode('pty-1')
      expect(runtime.isResizeSuppressed()).toBe(true)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
      resizes.length = 0

      runtime.recordRendererGeometry('pty-1', 130, 40)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
      expect(resizes).toEqual([])

      runtime.setMobileDisplayMode('pty-1', 'auto')
      await runtime.applyMobileDisplayMode('pty-1')
      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
      runtime.setMobileDisplayMode('pty-1', 'desktop')
      await runtime.applyMobileDisplayMode('pty-1')
      expect(ptySizes.get('pty-1')).toEqual({ cols: 130, rows: 40 })
    })
  })

  describe('backward compatibility', () => {
    it('old resizeForClient still works alongside new system', async () => {
      const { runtime, ptySizes } = createRuntime()

      const fitResult = await runtime.resizeForClient('pty-1', 'mobile-fit', 'client-old', 45, 20)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
      expect(fitResult.mode).toBe('mobile-fit')

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

      await vi.advanceTimersByTimeAsync(60_000)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
    })

    it('finite ms restores after the configured delay', async () => {
      settingsState.mobileAutoRestoreFitMs = 60_000
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.handleMobileUnsubscribe('pty-1', 'client-a')

      await vi.advanceTimersByTimeAsync(30_000)
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

      await vi.advanceTimersByTimeAsync(120_000)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
    })

    it('reclaimTerminalForDesktop with active subscriber keeps desktop mode until the phone acts', async () => {
      // #28487: reconnect/resume re-subscribe stays passive; only typing takes the floor.
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

      const ok = await runtime.reclaimTerminalForDesktop('pty-1')
      expect(ok).toBe(true)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
      expect(runtime.getMobileDisplayMode('pty-1')).toBe('desktop')

      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
      expect(runtime.getDriver('pty-1').kind).not.toBe('mobile')

      await runtime.mobileTookFloor('pty-1', 'client-a')
      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
      expect(runtime.getMobileDisplayMode('pty-1')).toBe('auto')
    })

    it('reclaim with WS disconnect between cycles — held branch restores correctly each time', async () => {
      // Repeated held-override reclaim must restore desktop geometry, never the current phone fit.
      settingsState.mobileAutoRestoreFitMs = null
      const { runtime, ptySizes } = createRuntime()

      for (let i = 0; i < 3; i++) {
        await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
        await runtime.mobileTookFloor('pty-1', 'client-a')
        expect(ptySizes.get('pty-1'), `iter ${i}: phone-fit`).toEqual({ cols: 45, rows: 20 })

        runtime.onClientDisconnected('client-a')
        await vi.advanceTimersByTimeAsync(0)
        await vi.advanceTimersByTimeAsync(60_000)
        expect(ptySizes.get('pty-1'), `iter ${i}: held after disconnect`).toEqual({
          cols: 45,
          rows: 20
        })
        expect(runtime.isMobileSubscriberActive('pty-1'), `iter ${i}: no subscribers`).toBe(false)
        expect(runtime.getTerminalFitOverride('pty-1'), `iter ${i}: override held`).not.toBeNull()

        const ok = await runtime.reclaimTerminalForDesktop('pty-1')
        expect(ok, `iter ${i}: reclaim ok`).toBe(true)
        expect(ptySizes.get('pty-1'), `iter ${i}: PTY restored to desktop`).toEqual({
          cols: 150,
          rows: 40
        })
        expect(runtime.getTerminalFitOverride('pty-1'), `iter ${i}: override cleared`).toBeNull()
      }
    })

    it('reclaim → re-subscribe → reclaim cycle works repeatedly', async () => {
      const { runtime, ptySizes } = createRuntime()

      for (let i = 0; i < 3; i++) {
        await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
        await runtime.mobileTookFloor('pty-1', 'client-a')
        expect(ptySizes.get('pty-1'), `iter ${i}: phone-fit`).toEqual({ cols: 45, rows: 20 })

        const ok = await runtime.reclaimTerminalForDesktop('pty-1')
        expect(ok, `iter ${i}: reclaim ok`).toBe(true)
        expect(ptySizes.get('pty-1'), `iter ${i}: reclaimed to desktop`).toEqual({
          cols: 150,
          rows: 40
        })
        expect(runtime.getTerminalFitOverride('pty-1'), `iter ${i}: override cleared`).toBeNull()
      }
    })

    it('null (indefinite) keeps PTY at phone dims when WS connection closes (onClientDisconnected)', async () => {
      // WS close bypasses handleMobileUnsubscribe but must still honor indefinite hold.
      settingsState.mobileAutoRestoreFitMs = null
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })

      runtime.onClientDisconnected('client-a')
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(60_000)

      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
      expect(runtime.getTerminalFitOverride('pty-1')).not.toBeNull()
    })

    it('reclaimTerminalForDesktop returns held PTY to desktop dims (no subscriber)', async () => {
      settingsState.mobileAutoRestoreFitMs = null
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.handleMobileUnsubscribe('pty-1', 'client-a')

      await runtime.reclaimTerminalForDesktop('pty-1')
      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })

      await vi.advanceTimersByTimeAsync(250)
      expect(runtime.getDriver('pty-1')).toEqual({ kind: 'desktop' })
    })

    it('reclaim cancels the soft-leave timer in the remote-layout branch', async () => {
      const { runtime } = createRuntime()
      await runtime.updateRemoteDesktopViewer('pty-1', 'sub-a', 'viewer-a', 120, 32)
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.handleMobileUnsubscribe('pty-1', 'client-a')

      expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)
      await vi.advanceTimersByTimeAsync(250)
      expect(runtime.getDriver('pty-1')).toEqual({ kind: 'desktop' })
    })

    it('reclaim cancels pending restore timers on the active-subscriber branch', async () => {
      const { runtime } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.handleMobileUnsubscribe('pty-1', 'client-a')
      await runtime.handleMobileSubscribe('pty-1', 'client-b', { cols: 40, rows: 18 })

      const pendingRestore = runtime.restoreTimers
      pendingRestore.set('pty-1', { timer: setTimeout(() => {}, 60_000), clientId: 'client-b' })
      const pendingSoft = runtime.softLeavers
      expect(pendingSoft.has('pty-1')).toBe(true)
      await runtime.reclaimTerminalForDesktop('pty-1')
      expect(pendingRestore.has('pty-1')).toBe(false)
      expect(pendingSoft.has('pty-1')).toBe(false)
    })

    it('reclaim cancels pending restore timers on the orphan-driver branch', async () => {
      const { runtime } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.handleMobileUnsubscribe('pty-1', 'client-a')
      runtime.fitOverrides.delete('pty-1')

      const pendingRestore = runtime.restoreTimers
      const pendingSoft = runtime.softLeavers
      await runtime.reclaimTerminalForDesktop('pty-1')
      expect(pendingRestore.has('pty-1')).toBe(false)
      expect(pendingSoft.has('pty-1')).toBe(false)
    })

    it('reclaim cancels pending restore timers when no driver lock remains', async () => {
      const { runtime } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.handleMobileUnsubscribe('pty-1', 'client-a')
      runtime.fitOverrides.delete('pty-1')
      runtime.drivers.set('pty-1', { kind: 'idle' })

      const pendingRestore = runtime.restoreTimers
      const pendingSoft = runtime.softLeavers
      expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(false)
      expect(pendingRestore.has('pty-1')).toBe(false)
      expect(pendingSoft.has('pty-1')).toBe(false)
    })

    it('reclaim revokes soft-leave grace admission for mobile input', async () => {
      const { runtime } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.handleMobileUnsubscribe('pty-1', 'client-a')

      const claim = runtime.beginMobileInputFloor('pty-1', 'client-a')
      expect(claim).not.toBeNull()
      claim?.rollback()

      await runtime.reclaimTerminalForDesktop('pty-1')
      expect(runtime.getDriver('pty-1')).toEqual({ kind: 'desktop' })
      expect(runtime.beginMobileInputFloor('pty-1', 'client-a')).toBeNull()
    })

    it('reclaimTerminalForDesktop prefers fresh desktop geometry for a held PTY', async () => {
      settingsState.mobileAutoRestoreFitMs = null
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.handleMobileUnsubscribe('pty-1', 'client-a')

      await vi.advanceTimersByTimeAsync(60_000)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

      runtime.recordRendererGeometry('pty-1', 180, 50)

      const ok = await runtime.reclaimTerminalForDesktop('pty-1')
      expect(ok).toBe(true)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 180, rows: 50 })
    })

    it('setMobileAutoRestoreFitMs(null) clears all pending timers', async () => {
      settingsState.mobileAutoRestoreFitMs = 60_000
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.handleMobileUnsubscribe('pty-1', 'client-a')

      runtime.setMobileAutoRestoreFitMs(null)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
    })

    it('setMobileAutoRestoreFitMs to a finite value does not retroactively schedule', async () => {
      settingsState.mobileAutoRestoreFitMs = null
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })
      runtime.handleMobileUnsubscribe('pty-1', 'client-a')

      // Finite preferences apply on the next unsubscribe, never retroactively to an existing hold.
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
      expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(false)
    })
  })
})
