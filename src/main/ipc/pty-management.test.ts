import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonSessionInfo } from '../daemon/types'

// Mirrors DaemonFolderAccessResetResult; declared here so the mock is not typed by the module it
// replaces.
type FolderAccessResetResult = {
  outcome: string
  mismatch?: { daemonScope: string; cwdClass: string; freshDaemonAccess: string } | null
}

const {
  handleMock,
  removeHandlerMock,
  getDaemonProviderMock,
  restartDaemonMock,
  getCurrentDaemonMacTccAttributionHealthMock,
  getDaemonFolderAccessMismatchMock,
  refreshDaemonFolderAccessProbeMock,
  resetFolderAccessForDaemonMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  getDaemonProviderMock: vi.fn(),
  restartDaemonMock: vi.fn(),
  getCurrentDaemonMacTccAttributionHealthMock: vi.fn(async () => 'unknown'),
  getDaemonFolderAccessMismatchMock: vi.fn<
    () => { daemonScope: string; cwdClass: string; freshDaemonAccess: string } | null
  >(() => null),
  refreshDaemonFolderAccessProbeMock: vi.fn(async () => {}),
  resetFolderAccessForDaemonMock: vi.fn<() => Promise<FolderAccessResetResult>>(async () => ({
    outcome: 'unsupported'
  }))
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

vi.mock('../daemon/daemon-folder-access-mismatch', () => ({
  getDaemonFolderAccessMismatch: getDaemonFolderAccessMismatchMock,
  refreshDaemonFolderAccessProbe: refreshDaemonFolderAccessProbeMock
}))

vi.mock('../daemon/daemon-folder-access-reset', () => ({
  resetFolderAccessForDaemon: resetFolderAccessForDaemonMock
}))

vi.mock('../daemon/daemon-init', () => ({
  getDaemonProvider: getDaemonProviderMock,
  restartDaemon: restartDaemonMock,
  getCurrentDaemonMacTccAttributionHealth: getCurrentDaemonMacTccAttributionHealthMock
}))

// Why: the handler uses `provider instanceof DaemonPtyRouter` to branch
// between "plain adapter" and "router with current + legacy adapters".
// Mock the class here so tests can construct real instances via `new
// DaemonPtyRouter(...)` and the instanceof check returns true. The real
// router's constructor is side-effect heavy (subscribes to adapter events),
// so we only keep the accessors that pty-management touches — enough to
// satisfy the runtime type check without pulling in all the wiring.
vi.mock('../daemon/daemon-pty-router', () => {
  class DaemonPtyRouter {
    private allAdapters: unknown[]
    private current: unknown
    constructor(opts: { current: unknown; legacy: unknown[] }) {
      this.current = opts.current
      this.allAdapters = [opts.current, ...opts.legacy]
    }
    getAllAdapters() {
      return this.allAdapters
    }
    // Why: the folder-access read asks the *current* adapter for the daemon identity.
    getCurrentAdapter() {
      return this.current
    }
    getLegacyAdapters() {
      return this.allAdapters.slice(1)
    }
  }
  return { DaemonPtyRouter }
})

// Why: the handler also branches on `provider instanceof DegradedDaemonPtyProvider`
// (for getAllAdapters) and reports `degraded` from it. The real constructor
// subscribes to adapter events, so keep only the accessors pty-management uses.
vi.mock('../daemon/degraded-daemon-pty-provider', () => {
  class DegradedDaemonPtyProvider {
    private allAdapters: unknown[]
    private current: unknown
    private routesFreshToFallback = true
    constructor(opts: { current: unknown; legacy: unknown[] }) {
      this.current = opts.current
      this.allAdapters = [opts.current, ...opts.legacy]
    }
    getCurrentAdapter() {
      return this.current
    }
    getLegacyAdapters() {
      return this.allAdapters.slice(1)
    }
    get routesFreshSpawnsToLocalProvider(): true | undefined {
      return this.routesFreshToFallback ? true : undefined
    }
    async recoverFreshSpawnRouting(): Promise<boolean> {
      this.routesFreshToFallback = false
      return true
    }
    getAllAdapters() {
      return this.allAdapters
    }
  }
  return { DegradedDaemonPtyProvider }
})

type HandlerMap = Record<string, (event: unknown, args?: unknown) => unknown>

function buildHandlerMap(): HandlerMap {
  const map: HandlerMap = {}
  for (const call of handleMock.mock.calls) {
    const [channel, handler] = call as [string, (event: unknown, args?: unknown) => unknown]
    map[channel] = handler
  }
  return map
}

function makeSession(
  sessionId: string,
  overrides: Partial<DaemonSessionInfo> = {}
): DaemonSessionInfo {
  return {
    sessionId,
    state: 'running',
    shellState: 'ready',
    isAlive: true,
    pid: 1234,
    cwd: '/home/user',
    cols: 80,
    rows: 24,
    createdAt: 0,
    protocolVersion: 5,
    ...overrides
  }
}

type MockAdapter = {
  protocolVersion: number
  listSessions: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
  getDaemonIdentity: ReturnType<typeof vi.fn>
}

function makeAdapter(
  protocolVersion: number,
  sessions: DaemonSessionInfo[],
  shutdownImpl?: (id: string, immediate: boolean) => Promise<void>
): MockAdapter {
  // Why: collectSessions calls adapter.listSessions() (the daemon-side RPC)
  // and then annotates with adapter.protocolVersion. The mock returns the
  // *internal* SessionInfo shape (no protocolVersion) since the adapter adds
  // it. Stripping it here mirrors production behavior.
  return {
    protocolVersion,
    listSessions: vi.fn(async () => sessions.map(({ protocolVersion: _pv, ...rest }) => rest)),
    shutdown: vi.fn(shutdownImpl ?? (async () => {})),
    getDaemonIdentity: vi.fn(() => ({ pid: 1530, startedAtMs: 1_700_000, launchNonce: 'n1' }))
  }
}

async function importFresh() {
  vi.resetModules()
  handleMock.mockClear()
  removeHandlerMock.mockClear()
  return import('./pty-management')
}

async function makeRouter(current: MockAdapter, legacy: MockAdapter[] = []) {
  const { DaemonPtyRouter } = await import('../daemon/daemon-pty-router')
  return new DaemonPtyRouter({ current: current as never, legacy: legacy as never })
}

async function makeDegradedProvider(current: MockAdapter, legacy: MockAdapter[] = []) {
  const { DegradedDaemonPtyProvider } = await import('../daemon/degraded-daemon-pty-provider')
  return new DegradedDaemonPtyProvider({
    current: current as never,
    legacy: legacy as never,
    fallback: undefined as never
  })
}

describe('pty:management IPC handlers', () => {
  beforeEach(() => {
    getDaemonProviderMock.mockReset()
    restartDaemonMock.mockReset()
    getCurrentDaemonMacTccAttributionHealthMock.mockReset()
    getCurrentDaemonMacTccAttributionHealthMock.mockResolvedValue('unknown')
    getDaemonFolderAccessMismatchMock.mockReset().mockReturnValue(null)
    refreshDaemonFolderAccessProbeMock.mockReset().mockResolvedValue(undefined)
    resetFolderAccessForDaemonMock.mockReset().mockResolvedValue({ outcome: 'unsupported' })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('listSessions', () => {
    it('merges sessions across current + legacy adapters with protocolVersion', async () => {
      const current = makeAdapter(5, [makeSession('new-1'), makeSession('new-2')])
      const legacy = makeAdapter(3, [makeSession('old-1', { protocolVersion: 3 })])
      const { registerDaemonManagementHandlers } = await importFresh()
      getDaemonProviderMock.mockReturnValue(await makeRouter(current, [legacy]))
      registerDaemonManagementHandlers()

      const handlers = buildHandlerMap()
      const result = (await handlers['pty:management:listSessions']({})) as {
        sessions: DaemonSessionInfo[]
        degraded: boolean
      }

      expect(result.sessions).toHaveLength(3)
      expect(result.degraded).toBe(false)
      const byId = new Map(result.sessions.map((s) => [s.sessionId, s]))
      expect(byId.get('new-1')?.protocolVersion).toBe(5)
      expect(byId.get('new-2')?.protocolVersion).toBe(5)
      expect(byId.get('old-1')?.protocolVersion).toBe(3)
    })

    it('reports degraded mode and still lists sessions when the daemon cannot spawn fresh PTYs', async () => {
      const current = makeAdapter(5, [makeSession('preserved-1')])
      const { registerDaemonManagementHandlers } = await importFresh()
      getDaemonProviderMock.mockReturnValue(await makeDegradedProvider(current))
      registerDaemonManagementHandlers()

      const handlers = buildHandlerMap()
      const result = (await handlers['pty:management:listSessions']({})) as {
        sessions: DaemonSessionInfo[]
        degraded: boolean
      }

      expect(result.degraded).toBe(true)
      expect(result.sessions.map((s) => s.sessionId)).toEqual(['preserved-1'])
    })

    it('clears degraded mode after durable fresh-spawn routing recovers', async () => {
      const current = makeAdapter(5, [makeSession('preserved-1')])
      const provider = await makeDegradedProvider(current)
      const { registerDaemonManagementHandlers } = await importFresh()
      getDaemonProviderMock.mockReturnValue(provider)
      registerDaemonManagementHandlers()
      const handler = buildHandlerMap()['pty:management:listSessions']

      await expect(handler({})).resolves.toMatchObject({ degraded: true })
      await provider.recoverFreshSpawnRouting()
      await expect(handler({})).resolves.toMatchObject({ degraded: false })
    })

    it('returns empty list when no daemon provider is installed', async () => {
      getDaemonProviderMock.mockReturnValue(null)

      const { registerDaemonManagementHandlers } = await importFresh()
      registerDaemonManagementHandlers()

      const handlers = buildHandlerMap()
      const result = (await handlers['pty:management:listSessions']({})) as {
        sessions: DaemonSessionInfo[]
      }

      expect(result.sessions).toEqual([])
    })

    it('tolerates a failing adapter by skipping its sessions', async () => {
      const current = makeAdapter(5, [makeSession('new-1')])
      const legacy = makeAdapter(3, [])
      legacy.listSessions = vi.fn(async () => {
        throw new Error('legacy socket dead')
      })
      const { registerDaemonManagementHandlers } = await importFresh()
      getDaemonProviderMock.mockReturnValue(await makeRouter(current, [legacy]))
      registerDaemonManagementHandlers()

      const handlers = buildHandlerMap()
      const result = (await handlers['pty:management:listSessions']({})) as {
        sessions: DaemonSessionInfo[]
      }

      expect(result.sessions).toHaveLength(1)
      expect(result.sessions[0].sessionId).toBe('new-1')
    })
  })

  describe('killAll', () => {
    // Why: the handler sleeps POLL_INTERVAL_MS between listSessions polls.
    // Fake timers let the tests drive that loop deterministically — without
    // them, a happy-path test that converges in ≥1 poll would take 100ms+
    // of real wall time and the "refuses to die" test would take ~1s.
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    async function runKillAllWithPolls(
      handler: (event: unknown, args?: unknown) => unknown,
      pollCount: number = 65
    ): Promise<{ killedCount: number; remainingCount: number; killedSessionIds: string[] }> {
      const resultPromise = handler({}) as Promise<{
        killedCount: number
        remainingCount: number
        killedSessionIds: string[]
      }>
      // Why: advance the loop's sleeps one at a time. Between each sleep the
      // handler awaits collectSessions (a microtask), so we need to flush
      // pending microtasks before advancing the next timer.
      for (let i = 0; i < pollCount; i += 1) {
        await Promise.resolve()
        await Promise.resolve()
        await vi.advanceTimersByTimeAsync(100)
      }
      return resultPromise
    }

    it('fires one shutdown per initial session and polls until empty', async () => {
      const currentSessions = [makeSession('new-1'), makeSession('new-2')]
      const legacySessions = [makeSession('old-1', { protocolVersion: 3 })]
      const current = makeAdapter(5, [])
      const legacy = makeAdapter(3, [])
      // Why: shutdown removes the session from the adapter's backing list so
      // the next poll observes the shrinking set — mirrors a daemon that
      // actually reaped the processes.
      const removeFrom = (list: DaemonSessionInfo[], id: string): void => {
        const idx = list.findIndex((s) => s.sessionId === id)
        if (idx !== -1) {
          list.splice(idx, 1)
        }
      }
      current.listSessions = vi.fn(async () =>
        currentSessions.map(({ protocolVersion: _pv, ...rest }) => rest)
      )
      legacy.listSessions = vi.fn(async () =>
        legacySessions.map(({ protocolVersion: _pv, ...rest }) => rest)
      )
      current.shutdown = vi.fn(async (id: string) => {
        removeFrom(currentSessions, id)
      })
      legacy.shutdown = vi.fn(async (id: string) => {
        removeFrom(legacySessions, id)
      })
      const { registerDaemonManagementHandlers } = await importFresh()
      getDaemonProviderMock.mockReturnValue(await makeRouter(current, [legacy]))
      registerDaemonManagementHandlers()

      const handlers = buildHandlerMap()
      const result = await runKillAllWithPolls(handlers['pty:management:killAll'])

      expect(result).toEqual({
        killedCount: 3,
        remainingCount: 0,
        killedSessionIds: ['new-1', 'new-2', 'old-1']
      })
      // Each initial session receives exactly one shutdown — no retries.
      expect(current.shutdown).toHaveBeenCalledTimes(2)
      expect(current.shutdown).toHaveBeenCalledWith('new-1', { immediate: true })
      expect(current.shutdown).toHaveBeenCalledWith('new-2', { immediate: true })
      expect(legacy.shutdown).toHaveBeenCalledTimes(1)
      expect(legacy.shutdown).toHaveBeenCalledWith('old-1', { immediate: true })
    })

    it('reports remainingCount when sessions refuse to die after the poll window', async () => {
      const sessions = [makeSession('stuck')]
      const current = makeAdapter(5, [])
      current.listSessions = vi.fn(async () =>
        sessions.map(({ protocolVersion: _pv, ...rest }) => rest)
      )
      // Why: shutdown resolves but the session never leaves listSessions —
      // simulates a process wedged in uninterruptible sleep. After the poll
      // window (≈6.5s, past the daemon's 5s SIGTERM→SIGKILL ladder) the
      // handler must return remainingCount=1 rather than loop forever.
      current.shutdown = vi.fn(async () => {})
      const { registerDaemonManagementHandlers } = await importFresh()
      getDaemonProviderMock.mockReturnValue(await makeRouter(current))
      registerDaemonManagementHandlers()

      const handlers = buildHandlerMap()
      const result = await runKillAllWithPolls(handlers['pty:management:killAll'])

      expect(result).toEqual({ killedCount: 0, remainingCount: 1, killedSessionIds: [] })
      // One shutdown fired — no per-session retry. Initial-snapshot
      // accounting means the stuck session is counted once.
      expect(current.shutdown).toHaveBeenCalledTimes(1)
    })

    it('does not count respawned sessions with fresh IDs against remainingCount', async () => {
      // Why: mounted panes may re-call pty:spawn with brand-new session IDs
      // while killAll is polling (tab remount, navigate-back). Those fresh
      // IDs are not part of the initial snapshot and must not inflate the
      // "refused to exit" count — the user asked to kill what was alive
      // when the button was pressed, not to chase new spawns.
      const liveSessions = [makeSession('a'), makeSession('b')]
      const current = makeAdapter(5, [])
      let pollCalls = 0
      current.listSessions = vi.fn(async () => {
        pollCalls += 1
        if (pollCalls === 1) {
          // Initial snapshot: a and b are alive.
          return liveSessions.map(({ protocolVersion: _pv, ...rest }) => rest)
        }
        // First poll onward: a and b have been reaped, but the renderer
        // respawned a fresh pane with id 'c'. 'c' was never in the initial
        // snapshot, so it must not count as remaining.
        return [makeSession('c')].map(({ protocolVersion: _pv, ...rest }) => rest)
      })
      current.shutdown = vi.fn(async () => {})
      const { registerDaemonManagementHandlers } = await importFresh()
      getDaemonProviderMock.mockReturnValue(await makeRouter(current))
      registerDaemonManagementHandlers()

      const handlers = buildHandlerMap()
      const result = await runKillAllWithPolls(handlers['pty:management:killAll'])

      expect(result).toEqual({
        killedCount: 2,
        remainingCount: 0,
        killedSessionIds: ['a', 'b']
      })
    })

    it('swallows per-session shutdown rejections without stopping the batch', async () => {
      const sessionsList = [makeSession('a'), makeSession('b')]
      const current = makeAdapter(5, [])
      current.listSessions = vi.fn(async () =>
        sessionsList.map(({ protocolVersion: _pv, ...rest }) => rest)
      )
      // Why: a rejecting shutdown for 'a' must not block the shutdown of 'b'.
      // Since shutdowns fire in parallel (Promise.allSettled), both must be
      // invoked regardless of 'a' throwing.
      const removeFrom = (id: string): void => {
        const idx = sessionsList.findIndex((s) => s.sessionId === id)
        if (idx !== -1) {
          sessionsList.splice(idx, 1)
        }
      }
      current.shutdown = vi.fn(async (id: string) => {
        if (id === 'a') {
          throw new Error('a is stuck')
        }
        removeFrom(id)
      })
      const { registerDaemonManagementHandlers } = await importFresh()
      getDaemonProviderMock.mockReturnValue(await makeRouter(current))
      registerDaemonManagementHandlers()

      const handlers = buildHandlerMap()
      const result = await runKillAllWithPolls(handlers['pty:management:killAll'])

      expect(current.shutdown).toHaveBeenCalledWith('a', { immediate: true })
      expect(current.shutdown).toHaveBeenCalledWith('b', { immediate: true })
      // 'a' rejected and is still alive → counts as remaining; 'b' reaped.
      expect(result).toEqual({
        killedCount: 1,
        remainingCount: 1,
        killedSessionIds: ['b']
      })
    })
  })

  describe('killOne', () => {
    it('routes to the adapter whose protocolVersion owns the session', async () => {
      const current = makeAdapter(5, [makeSession('new-1')])
      const legacy = makeAdapter(3, [makeSession('old-1', { protocolVersion: 3 })])
      const { registerDaemonManagementHandlers } = await importFresh()
      getDaemonProviderMock.mockReturnValue(await makeRouter(current, [legacy]))
      registerDaemonManagementHandlers()

      const handlers = buildHandlerMap()
      const result = (await handlers['pty:management:killOne']({}, { sessionId: 'old-1' })) as {
        success: boolean
      }

      expect(result.success).toBe(true)
      expect(legacy.shutdown).toHaveBeenCalledWith('old-1', { immediate: true })
      expect(current.shutdown).not.toHaveBeenCalled()
    })

    it('returns success=false for unknown sessionId', async () => {
      const current = makeAdapter(5, [makeSession('new-1')])
      const { registerDaemonManagementHandlers } = await importFresh()
      getDaemonProviderMock.mockReturnValue(await makeRouter(current))
      registerDaemonManagementHandlers()

      const handlers = buildHandlerMap()
      const result = (await handlers['pty:management:killOne']({}, { sessionId: 'ghost' })) as {
        success: boolean
      }

      expect(result.success).toBe(false)
      expect(current.shutdown).not.toHaveBeenCalled()
    })

    it('rejects empty/missing sessionId without hitting the adapter', async () => {
      const current = makeAdapter(5, [makeSession('new-1')])
      const { registerDaemonManagementHandlers } = await importFresh()
      getDaemonProviderMock.mockReturnValue(await makeRouter(current))
      registerDaemonManagementHandlers()

      const handlers = buildHandlerMap()
      const result = (await handlers['pty:management:killOne']({}, { sessionId: '' })) as {
        success: boolean
      }

      expect(result.success).toBe(false)
      expect(current.listSessions).not.toHaveBeenCalled()
    })
  })

  describe('macTccAttribution', () => {
    type AttributionResult = {
      health: string
      folderAccessMismatch: {
        daemonScope: string
        cwdClass: string
        freshDaemonAccess: string
      } | null
    }

    async function readAttribution(): Promise<AttributionResult> {
      const { registerDaemonManagementHandlers } = await importFresh()
      registerDaemonManagementHandlers()
      const handlers = buildHandlerMap()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler map is untyped by construction; this channel's handler is the one registered above.
      return (await handlers['pty:management:macTccAttribution']({})) as AttributionResult
    }

    it('reports the daemon attribution health', async () => {
      getCurrentDaemonMacTccAttributionHealthMock.mockResolvedValue('severed')

      const result = await readAttribution()

      expect(result.health).toBe('severed')
      expect(result.folderAccessMismatch).toBeNull()
    })

    it('fails open to unknown when the probe throws, keeping the folder evidence', async () => {
      getCurrentDaemonMacTccAttributionHealthMock.mockRejectedValue(new Error('no pid record'))
      const current = makeAdapter(5, [])
      getDaemonProviderMock.mockReturnValue(await makeRouter(current, []))
      getDaemonFolderAccessMismatchMock.mockReturnValue(evidence('denied'))

      const result = await readAttribution()

      expect(result.health).toBe('unknown')
      expect(result.folderAccessMismatch).toEqual(evidence('denied'))
    })

    it('carries folder-access evidence for the current daemon', async () => {
      const current = makeAdapter(5, [])
      getDaemonProviderMock.mockReturnValue(await makeRouter(current, [makeAdapter(4, [])]))
      getDaemonFolderAccessMismatchMock.mockReturnValue({
        daemonScope: 'abc123def4567890',
        cwdClass: 'documents',
        freshDaemonAccess: 'allowed'
      })

      const result = await readAttribution()

      expect(result.folderAccessMismatch).toEqual({
        daemonScope: 'abc123def4567890',
        cwdClass: 'documents',
        freshDaemonAccess: 'allowed'
      })
      // Why: evidence belongs to the daemon spawning terminals now, never a legacy adapter's.
      expect(getDaemonFolderAccessMismatchMock).toHaveBeenCalledWith({
        pid: 1530,
        startedAtMs: 1_700_000,
        launchNonce: 'n1'
      })
      expect(current.getDaemonIdentity).toHaveBeenCalled()
    })

    function evidence(freshDaemonAccess: string): {
      daemonScope: string
      cwdClass: string
      freshDaemonAccess: string
    } {
      return { daemonScope: 'abc123def4567890', cwdClass: 'documents', freshDaemonAccess }
    }

    // Why re-probe on the poll: the fix dialog's first step completes in System Settings, and
    // this is the only moment anything can notice that it landed.
    it.each([['denied'], ['unknown']])(
      'reports the verdict the re-probe leaves behind, not the %s one it started from',
      async (initial) => {
        getDaemonFolderAccessMismatchMock.mockReturnValue(evidence(initial))
        refreshDaemonFolderAccessProbeMock.mockImplementation(async () => {
          getDaemonFolderAccessMismatchMock.mockReturnValue(evidence('allowed'))
        })

        const result = await readAttribution()

        expect(refreshDaemonFolderAccessProbeMock).toHaveBeenCalledTimes(1)
        expect(result.folderAccessMismatch?.freshDaemonAccess).toBe('allowed')
      }
    )

    // Whether a refresh is worth running is the refresh's own decision; the handler just reports
    // whatever evidence is there afterwards.
    it('reports a settled allowed verdict unchanged', async () => {
      getDaemonFolderAccessMismatchMock.mockReturnValue(evidence('allowed'))

      const result = await readAttribution()

      expect(result.folderAccessMismatch).toEqual(evidence('allowed'))
    })

    it('reports no evidence at all as no mismatch', async () => {
      getDaemonFolderAccessMismatchMock.mockReturnValue(null)

      const result = await readAttribution()

      expect(result.folderAccessMismatch).toBeNull()
    })

    it('keeps the folder evidence when the refresh throws', async () => {
      getDaemonFolderAccessMismatchMock.mockReturnValue(evidence('denied'))
      refreshDaemonFolderAccessProbeMock.mockRejectedValue(new Error('probe exploded'))

      const result = await readAttribution()

      expect(result.folderAccessMismatch).toEqual(evidence('denied'))
    })

    it('reads a null identity when no daemon provider exists', async () => {
      getDaemonProviderMock.mockReturnValue(null)

      const result = await readAttribution()

      expect(getDaemonFolderAccessMismatchMock).toHaveBeenCalledWith(null)
      expect(result.folderAccessMismatch).toBeNull()
    })
  })

  describe('restart', () => {
    it('delegates to restartDaemon and reports success', async () => {
      restartDaemonMock.mockResolvedValue({ killedCount: 2 })

      const { registerDaemonManagementHandlers } = await importFresh()
      registerDaemonManagementHandlers()

      const handlers = buildHandlerMap()
      const result = (await handlers['pty:management:restart']({})) as { success: boolean }

      expect(result.success).toBe(true)
      expect(restartDaemonMock).toHaveBeenCalledTimes(1)
    })

    it('returns success=false when restartDaemon throws', async () => {
      restartDaemonMock.mockRejectedValue(new Error('spawn failed'))

      const { registerDaemonManagementHandlers } = await importFresh()
      registerDaemonManagementHandlers()

      const handlers = buildHandlerMap()
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const result = (await handlers['pty:management:restart']({})) as { success: boolean }
      consoleErrorSpy.mockRestore()

      expect(result.success).toBe(false)
    })
  })

  describe('resetFolderAccess', () => {
    async function runReset(): Promise<FolderAccessResetResult> {
      const { registerDaemonManagementHandlers } = await importFresh()
      registerDaemonManagementHandlers()
      const handlers = buildHandlerMap()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler map is untyped by construction; this channel's handler is the one registered above.
      return (await handlers['pty:management:resetFolderAccess']({})) as FolderAccessResetResult
    }

    it('hands the current daemon to the reset and returns its verdict', async () => {
      const current = makeAdapter(5, [])
      getDaemonProviderMock.mockReturnValue(await makeRouter(current, [makeAdapter(4, [])]))
      resetFolderAccessForDaemonMock.mockResolvedValue({
        outcome: 'probed',
        mismatch: {
          daemonScope: 'abc123def4567890',
          cwdClass: 'documents',
          freshDaemonAccess: 'allowed'
        }
      })

      expect(await runReset()).toEqual({
        outcome: 'probed',
        mismatch: {
          daemonScope: 'abc123def4567890',
          cwdClass: 'documents',
          freshDaemonAccess: 'allowed'
        }
      })
      // Why the current adapter: a legacy daemon's denial is not the one the user is looking at.
      expect(resetFolderAccessForDaemonMock).toHaveBeenCalledWith({
        pid: 1530,
        startedAtMs: 1_700_000,
        launchNonce: 'n1'
      })
    })

    it('reports unsupported rather than rejecting when the reset throws', async () => {
      resetFolderAccessForDaemonMock.mockRejectedValue(new Error('no app bundle'))

      expect(await runReset()).toEqual({ outcome: 'unsupported' })
    })

    it('registers the channel exactly once per registration', async () => {
      const { registerDaemonManagementHandlers } = await importFresh()
      registerDaemonManagementHandlers()

      expect(removeHandlerMock).toHaveBeenCalledWith('pty:management:resetFolderAccess')
      expect(buildHandlerMap()['pty:management:resetFolderAccess']).toBeTypeOf('function')
    })
  })
})
