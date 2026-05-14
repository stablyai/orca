/* eslint-disable max-lines -- Why: covers every pty:management IPC channel
against shared mocks (electron, fs, daemon-init, DaemonPtyRouter). Splitting
across files would duplicate the vi.hoisted setup and the shared helpers,
with no meaningful ownership seam. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonSessionInfo } from '../daemon/types'

const { handleMock, removeHandlerMock, getDaemonProviderMock, restartDaemonMock } = vi.hoisted(
  () => ({
    handleMock: vi.fn(),
    removeHandlerMock: vi.fn(),
    getDaemonProviderMock: vi.fn(),
    restartDaemonMock: vi.fn()
  })
)

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

vi.mock('../daemon/daemon-init', () => ({
  getDaemonProvider: getDaemonProviderMock,
  restartDaemon: restartDaemonMock
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
    constructor(opts: { current: unknown; legacy: unknown[] }) {
      this.allAdapters = [opts.current, ...opts.legacy]
    }
    getAllAdapters() {
      return this.allAdapters
    }
  }
  return { DaemonPtyRouter }
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
    shutdown: vi.fn(shutdownImpl ?? (async () => {}))
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

describe('pty:management IPC handlers', () => {
  beforeEach(() => {
    getDaemonProviderMock.mockReset()
    restartDaemonMock.mockReset()
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
      }

      expect(result.sessions).toHaveLength(3)
      const byId = new Map(result.sessions.map((s) => [s.sessionId, s]))
      expect(byId.get('new-1')?.protocolVersion).toBe(5)
      expect(byId.get('new-2')?.protocolVersion).toBe(5)
      expect(byId.get('old-1')?.protocolVersion).toBe(3)
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
    ): Promise<{ killedCount: number; remainingCount: number }> {
      const resultPromise = handler({}) as Promise<{
        killedCount: number
        remainingCount: number
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

      expect(result).toEqual({ killedCount: 3, remainingCount: 0 })
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

      expect(result).toEqual({ killedCount: 0, remainingCount: 1 })
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

      expect(result).toEqual({ killedCount: 2, remainingCount: 0 })
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
      expect(result).toEqual({ killedCount: 1, remainingCount: 1 })
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
})
