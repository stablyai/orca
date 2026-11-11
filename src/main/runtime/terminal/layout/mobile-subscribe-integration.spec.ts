import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { listWorktrees } from '../../../git/worktrees/catalog/worktree-scan-cache'
import { OrcaRuntimeService } from '../../orca-runtime'

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

  describe('onExternalPtyResize', () => {
    it('ignores reports while a mobile-fit override is in place', async () => {
      // Phone-fit echoes must not poison the desktop restore baseline; see docs/mobile-fit-hold.md.
      const { runtime, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'client-a', { cols: 45, rows: 20 })

      runtime.onExternalPtyResize('pty-1', 45, 20)

      runtime.setMobileDisplayMode('pty-1', 'desktop')
      await runtime.applyMobileDisplayMode('pty-1')
      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
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

  // See docs/mobile-fit-hold.md.
  describe('mobileAutoRestoreFitMs (fit hold)', () => {
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
  })
})
