import { describe, expect, it, vi } from 'vitest'
import { DaemonPtyRouter } from './daemon-pty-router'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { PtySpawnOptions, PtySpawnResult } from '../providers/types'

type AdapterMock = DaemonPtyAdapter & {
  emitData: (id: string, data: string) => void
  emitExit: (id: string, code: number) => void
}

function createAdapter(
  label: string,
  sessions: string[] = [],
  reconcileResult?: { alive: string[]; killed: string[] }
): AdapterMock {
  const writes: { id: string; data: string }[] = []
  const dataListeners: ((payload: { id: string; data: string }) => void)[] = []
  const exitListeners: ((payload: { id: string; code: number }) => void)[] = []
  return {
    spawn: vi.fn(async (opts: PtySpawnOptions): Promise<PtySpawnResult> => {
      const id = opts.sessionId ?? `${label}-new`
      sessions.push(id)
      return { id }
    }),
    listProcesses: vi.fn(async () =>
      sessions.map((id) => ({
        id,
        cwd: '',
        title: label
      }))
    ),
    write: vi.fn((id: string, data: string) => {
      writes.push({ id, data })
    }),
    resize: vi.fn(),
    shutdown: vi.fn(async (id: string) => {
      const idx = sessions.indexOf(id)
      if (idx !== -1) {
        sessions.splice(idx, 1)
      }
    }),
    attach: vi.fn(async () => {}),
    sendSignal: vi.fn(async () => {}),
    getCwd: vi.fn(async () => ''),
    getInitialCwd: vi.fn(async () => ''),
    clearBuffer: vi.fn(async () => {}),
    acknowledgeDataEvent: vi.fn(),
    hasChildProcesses: vi.fn(async () => false),
    getForegroundProcess: vi.fn(async () => null),
    serialize: vi.fn(async () => '{}'),
    revive: vi.fn(async () => {}),
    getDefaultShell: vi.fn(async () => '/bin/zsh'),
    getProfiles: vi.fn(async () => []),
    onData: vi.fn((callback: (payload: { id: string; data: string }) => void) => {
      dataListeners.push(callback)
      return () => {
        const idx = dataListeners.indexOf(callback)
        if (idx !== -1) {
          dataListeners.splice(idx, 1)
        }
      }
    }),
    onExit: vi.fn((callback: (payload: { id: string; code: number }) => void) => {
      exitListeners.push(callback)
      return () => {
        const idx = exitListeners.indexOf(callback)
        if (idx !== -1) {
          exitListeners.splice(idx, 1)
        }
      }
    }),
    ackColdRestore: vi.fn(),
    clearTombstone: vi.fn(),
    reconcileOnStartup: vi.fn(async () => reconcileResult ?? { alive: sessions, killed: [] }),
    dispose: vi.fn(),
    disconnectOnly: vi.fn(async () => {}),
    emitData: (id: string, data: string) => {
      for (const listener of dataListeners) {
        listener({ id, data })
      }
    },
    emitExit: (id: string, code: number) => {
      for (const listener of exitListeners) {
        listener({ id, code })
      }
    },
    _writes: writes
  } as unknown as AdapterMock
}

describe('DaemonPtyRouter', () => {
  it('routes existing legacy sessions to their old daemon and new sessions to current daemon', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', ['legacy-session'])
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })

    await router.discoverLegacySessions()

    await router.spawn({ sessionId: 'legacy-session', cols: 80, rows: 24 })
    const fresh = await router.spawn({ cols: 80, rows: 24 })
    router.write('legacy-session', 'old\n')
    router.write(fresh.id, 'new\n')

    expect(legacy.spawn).toHaveBeenCalledWith({ sessionId: 'legacy-session', cols: 80, rows: 24 })
    expect(current.spawn).toHaveBeenCalledWith({ cols: 80, rows: 24 })
    expect(legacy.write).toHaveBeenCalledWith('legacy-session', 'old\n')
    expect(current.write).toHaveBeenCalledWith(fresh.id, 'new\n')
  })

  it('drops a legacy mapping after the routed session exits', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', ['legacy-session'])
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })

    await router.discoverLegacySessions()

    legacy.emitExit('legacy-session', 0)
    await router.spawn({ sessionId: 'legacy-session', cols: 80, rows: 24 })

    expect(current.spawn).toHaveBeenCalledWith({ sessionId: 'legacy-session', cols: 80, rows: 24 })
  })

  it('merges startup reconciliation and updates route mappings', async () => {
    const current = createAdapter('current', [], {
      alive: ['current-alive'],
      killed: ['current-killed']
    })
    const legacy = createAdapter('legacy', [], {
      alive: ['legacy-alive'],
      killed: ['legacy-killed']
    })
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })

    const result = await router.reconcileOnStartup(new Set(['wt']))
    router.write('legacy-alive', 'old\n')
    router.write('current-alive', 'new\n')

    expect(result).toEqual({
      alive: ['current-alive', 'legacy-alive'],
      killed: ['current-killed', 'legacy-killed']
    })
    expect(legacy.write).toHaveBeenCalledWith('legacy-alive', 'old\n')
    expect(current.write).toHaveBeenCalledWith('current-alive', 'new\n')
  })

  it('disposes current and legacy adapters', () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy')
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })

    router.dispose()

    expect(current.dispose).toHaveBeenCalled()
    expect(legacy.dispose).toHaveBeenCalled()
  })

  // Why: docs/daemon-staleness-ux.md §Phase 1 step 5 requires the restart flow
  // to preserve the legacy adapter instances across the current-adapter swap,
  // and it reads them back via these accessors. Locking the return shape
  // prevents a future refactor from quietly switching to a defensive copy
  // (breaks instance identity) or a different list (breaks restart).
  describe('restart accessors', () => {
    it('returns the exact current adapter instance', () => {
      const current = createAdapter('current')
      const router = new DaemonPtyRouter({ current, legacy: [] })

      expect(router.getCurrentAdapter()).toBe(current)
    })

    it('returns the exact legacy adapter instances', () => {
      const current = createAdapter('current')
      const legacy1 = createAdapter('legacy-1')
      const legacy2 = createAdapter('legacy-2')
      const router = new DaemonPtyRouter({ current, legacy: [legacy1, legacy2] })

      const legacies = router.getLegacyAdapters()
      expect(legacies.length).toBe(2)
      expect(legacies[0]).toBe(legacy1)
      expect(legacies[1]).toBe(legacy2)
    })

    it('getAllAdapters returns current first then legacy, by identity', () => {
      const current = createAdapter('current')
      const legacy1 = createAdapter('legacy-1')
      const legacy2 = createAdapter('legacy-2')
      const router = new DaemonPtyRouter({ current, legacy: [legacy1, legacy2] })

      const all = router.getAllAdapters()
      expect(all.length).toBe(3)
      expect(all[0]).toBe(current)
      expect(all[1]).toBe(legacy1)
      expect(all[2]).toBe(legacy2)
    })
  })

  // Why: the restart flow (daemon-init.runRestartDaemon step 5→6) relies on
  // disposeRouterOnly draining the outgoing router's subscriptions WITHOUT
  // tearing down the legacy adapters themselves. plain dispose() would
  // cascade into the adapters and strand any legacy-backed sessions — see
  // daemon-pty-router.ts §disposeRouterOnly comment. These tests lock the
  // contract: no adapter teardown, subscriptions actually detached for both
  // onData and onExit on both current and legacy, idempotent.
  describe('disposeRouterOnly', () => {
    it('does not call dispose or disconnectOnly on any adapter', () => {
      const current = createAdapter('current')
      const legacy = createAdapter('legacy')
      const router = new DaemonPtyRouter({ current, legacy: [legacy] })

      router.disposeRouterOnly()

      expect(current.dispose).not.toHaveBeenCalled()
      expect(legacy.dispose).not.toHaveBeenCalled()
      expect(current.disconnectOnly).not.toHaveBeenCalled()
      expect(legacy.disconnectOnly).not.toHaveBeenCalled()
    })

    it('stops forwarding adapter onData/onExit to subscribers registered before dispose', () => {
      const current = createAdapter('current')
      const legacy = createAdapter('legacy')
      const router = new DaemonPtyRouter({ current, legacy: [legacy] })

      // Realistic restart scenario: the local IPC layer subscribes at app
      // start, THEN the restart flow later calls disposeRouterOnly. A spy
      // registered *after* dispose proves the router→subscriber path is
      // empty, but doesn't prove the router unsubscribed from the adapters.
      const dataSpy = vi.fn()
      const exitSpy = vi.fn()
      router.onData(dataSpy)
      router.onExit(exitSpy)

      router.disposeRouterOnly()

      // Both current- and legacy-adapter emissions must be silenced. A
      // regression that only unsubscribed from one would pass a single-
      // adapter test but fail this one.
      current.emitData('current-id', 'hello')
      current.emitExit('current-id', 0)
      legacy.emitData('legacy-id', 'world')
      legacy.emitExit('legacy-id', 1)

      expect(dataSpy).not.toHaveBeenCalled()
      expect(exitSpy).not.toHaveBeenCalled()
    })

    it('is idempotent — a second disposeRouterOnly call is a no-op and does not throw', () => {
      const current = createAdapter('current')
      const legacy = createAdapter('legacy')
      const router = new DaemonPtyRouter({ current, legacy: [legacy] })

      router.disposeRouterOnly()
      expect(() => router.disposeRouterOnly()).not.toThrow()
      // And still no adapter teardown on the second call.
      expect(current.dispose).not.toHaveBeenCalled()
      expect(legacy.dispose).not.toHaveBeenCalled()
    })
  })
})
