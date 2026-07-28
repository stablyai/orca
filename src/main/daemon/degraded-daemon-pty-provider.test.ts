import { describe, expect, it, vi } from 'vitest'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../providers/types'
import type { PtyProcessInspection } from '../providers/pty-process-inspection'

type ProviderMock = IPtyProvider & {
  inspectProcess: (id: string) => Promise<PtyProcessInspection>
  emitData: (id: string, data: string, sequenceChars?: number) => void
  emitReplay: (id: string, data: string) => void
  emitExit: (id: string, code: number) => void
  triggerWriteUnavailable: (id: string) => void
  onWriteUnavailable: (callback: (payload: { id: string }) => void) => () => void
}

function createProvider(
  label: string,
  sessions: string[] = [],
  authoritativeOwnerListings = false
): ProviderMock {
  const dataListeners: ((payload: { id: string; data: string; sequenceChars?: number }) => void)[] =
    []
  const replayListeners: ((payload: { id: string; data: string }) => void)[] = []
  const exitListeners: ((payload: { id: string; code: number }) => void)[] = []
  const writeUnavailableListeners: ((payload: { id: string }) => void)[] = []
  return {
    spawn: vi.fn(async (opts: PtySpawnOptions): Promise<PtySpawnResult> => {
      const id = opts.sessionId ?? `${label}-new`
      sessions.push(id)
      return { id }
    }),
    attach: vi.fn(async () => {}),
    hasPty: vi.fn((id: string) => sessions.includes(id)),
    providesAgentSessionOwnerListings: vi.fn(() => authoritativeOwnerListings),
    write: vi.fn(),
    resize: vi.fn(),
    shutdown: vi.fn(async (id: string) => {
      const idx = sessions.indexOf(id)
      if (idx !== -1) {
        sessions.splice(idx, 1)
      }
    }),
    sendSignal: vi.fn(async () => {}),
    getCwd: vi.fn(async () => ''),
    getInitialCwd: vi.fn(async () => ''),
    clearBuffer: vi.fn(async () => {}),
    acknowledgeDataEvent: vi.fn(),
    hasChildProcesses: vi.fn(async () => false),
    getForegroundProcess: vi.fn(async () => null),
    inspectProcess: vi.fn(async () => ({ foregroundProcess: null, hasChildProcesses: false })),
    confirmForegroundProcess: vi.fn(async () => `${label}-confirmed`),
    serialize: vi.fn(async () => '{}'),
    revive: vi.fn(async () => {}),
    listProcesses: vi.fn(async () => sessions.map((id) => ({ id, cwd: '', title: label }))),
    getDefaultShell: vi.fn(async () => '/bin/zsh'),
    getProfiles: vi.fn(async () => []),
    onData: vi.fn(
      (callback: (payload: { id: string; data: string; sequenceChars?: number }) => void) => {
        dataListeners.push(callback)
        return () => {
          const idx = dataListeners.indexOf(callback)
          if (idx !== -1) {
            dataListeners.splice(idx, 1)
          }
        }
      }
    ),
    onReplay: vi.fn((callback: (payload: { id: string; data: string }) => void) => {
      replayListeners.push(callback)
      return () => {
        const idx = replayListeners.indexOf(callback)
        if (idx !== -1) {
          replayListeners.splice(idx, 1)
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
    emitData: (id: string, data: string, sequenceChars?: number) => {
      for (const listener of dataListeners) {
        listener({ id, data, ...(sequenceChars === undefined ? {} : { sequenceChars }) })
      }
    },
    emitReplay: (id: string, data: string) => {
      for (const listener of replayListeners) {
        listener({ id, data })
      }
    },
    emitExit: (id: string, code: number) => {
      for (const listener of exitListeners) {
        listener({ id, code })
      }
    },
    onWriteUnavailable: vi.fn((callback: (payload: { id: string }) => void) => {
      writeUnavailableListeners.push(callback)
      return () => {
        const idx = writeUnavailableListeners.indexOf(callback)
        if (idx !== -1) {
          writeUnavailableListeners.splice(idx, 1)
        }
      }
    }),
    triggerWriteUnavailable: (id: string) => {
      for (const listener of writeUnavailableListeners) {
        listener({ id })
      }
    }
  }
}

function createDaemonAdapter(
  label: string,
  sessions: string[] = []
): DaemonPtyAdapter & ProviderMock {
  return {
    ...createProvider(label, sessions, true),
    protocolVersion: 13,
    listSessions: vi.fn(async () => []),
    ackColdRestore: vi.fn(),
    clearTombstone: vi.fn(),
    reconcileOnStartup: vi.fn(async () => ({ alive: sessions, killed: [] })),
    dispose: vi.fn(),
    disconnectOnly: vi.fn(async () => {}),
    getActiveSessionIds: vi.fn(() => []),
    fanoutSyntheticExits: vi.fn()
  } as unknown as DaemonPtyAdapter & ProviderMock
}

it('forwards dead-endpoint write-unavailable signals from the daemon adapters', () => {
  // Why revert-sensitive: this provider is the live localProvider in degraded launch
  // mode and main subscribes on it, so without forwarding the STA-2373 fan-out reaches
  // no listener and sibling panes stay frozen.
  const current = createDaemonAdapter('daemon')
  const legacy = createDaemonAdapter('legacy')
  const fallback = createProvider('fallback')
  const provider = new DegradedDaemonPtyProvider({ current, legacy: [legacy], fallback })
  const recovered: string[] = []

  const unsubscribe = provider.onWriteUnavailable(({ id }) => recovered.push(id))
  current.triggerWriteUnavailable('daemon-pane')
  legacy.triggerWriteUnavailable('legacy-pane')
  expect(recovered).toEqual(['daemon-pane', 'legacy-pane'])

  unsubscribe()
  current.triggerWriteUnavailable('after-unsubscribe')
  expect(recovered).toEqual(['daemon-pane', 'legacy-pane'])
})

it('rejects completion inspection instead of borrowing the fallback provider', async () => {
  const provider = new DegradedDaemonPtyProvider({
    current: createDaemonAdapter('daemon'),
    legacy: [],
    fallback: createProvider('fallback')
  })

  await expect(provider.inspectProcess('unmapped-session')).rejects.toThrow('terminal_gone')
})

it('preserves unavailable inspection from an owning daemon', async () => {
  const daemon = createDaemonAdapter('daemon', ['daemon-session'])
  vi.mocked(daemon.inspectProcess).mockResolvedValue({
    foregroundProcess: null,
    hasChildProcesses: true,
    unavailable: true
  })
  const provider = new DegradedDaemonPtyProvider({
    current: daemon,
    legacy: [],
    fallback: createProvider('fallback')
  })
  await provider.discoverDaemonSessions()

  await expect(provider.inspectProcess('daemon-session')).resolves.toEqual({
    foregroundProcess: null,
    hasChildProcesses: true,
    unavailable: true
  })
})

describe('DegradedDaemonPtyProvider', () => {
  it('only delegates owner-listing authority to the provider that owns the id', async () => {
    const current = createDaemonAdapter('daemon', ['daemon-session'])
    const fallback = createProvider('fallback', [], true)
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })
    await provider.discoverDaemonSessions()

    expect(provider.providesAgentSessionOwnerListings('daemon-session')).toBe(true)
    expect(provider.providesAgentSessionOwnerListings('unknown-session')).toBe(false)
  })

  it('routes fresh foreground confirmation to the session owner', async () => {
    const current = createDaemonAdapter('daemon', ['daemon-session'])
    const fallback = createProvider('fallback')
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })
    await provider.discoverDaemonSessions()
    const fresh = await provider.spawn({ cols: 80, rows: 24 })

    await expect(provider.confirmForegroundProcess('daemon-session')).resolves.toBe(
      'daemon-confirmed'
    )
    await expect(provider.confirmForegroundProcess(fresh.id)).resolves.toBe('fallback-confirmed')
  })

  it('routes discovered daemon sessions to the daemon and fresh PTYs to the fallback', async () => {
    const current = createDaemonAdapter('daemon', ['daemon-session'])
    const fallback = createProvider('fallback')
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })

    await provider.discoverDaemonSessions()

    await provider.spawn({ sessionId: 'daemon-session', cols: 80, rows: 24 })
    const fresh = await provider.spawn({ cols: 80, rows: 24 })
    provider.write('daemon-session', 'old\n')
    provider.write(fresh.id, 'new\n')

    expect(current.spawn).toHaveBeenCalledWith({ sessionId: 'daemon-session', cols: 80, rows: 24 })
    expect(fallback.spawn).toHaveBeenCalledWith({ cols: 80, rows: 24 })
    expect(current.write).toHaveBeenCalledWith('daemon-session', 'old\n')
    expect(fallback.write).toHaveBeenCalledWith(fresh.id, 'new\n')
  })

  it('routes a previously daemon-backed id to fallback after daemon exit removes the mapping', async () => {
    const current = createDaemonAdapter('daemon', ['daemon-session'])
    const fallback = createProvider('fallback')
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })

    await provider.discoverDaemonSessions()
    current.emitExit('daemon-session', 0)
    await provider.spawn({ sessionId: 'daemon-session', cols: 80, rows: 24 })

    expect(fallback.spawn).toHaveBeenCalledWith({
      sessionId: 'daemon-session',
      cols: 80,
      rows: 24
    })
  })

  it('caches a provider discovered by hasPty before routing later operations', () => {
    const current = createDaemonAdapter('daemon', ['daemon-session'])
    const fallback = createProvider('fallback')
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })

    expect(provider.hasPty('daemon-session')).toBe(true)
    provider.write('daemon-session', 'kept-on-daemon\n')

    expect(current.write).toHaveBeenCalledWith('daemon-session', 'kept-on-daemon\n')
    expect(fallback.write).not.toHaveBeenCalled()
  })

  it('routes authoritative recovery snapshots to the owning daemon', async () => {
    const current = createDaemonAdapter('daemon', ['daemon-session'])
    const fallback = createProvider('fallback')
    const snapshot = {
      data: 'alt frame',
      scrollbackAnsi: 'normal history',
      cols: 80,
      rows: 24,
      seq: 42,
      source: 'headless' as const
    }
    current.getBufferSnapshot = vi.fn(async () => snapshot)
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })

    await provider.discoverDaemonSessions()

    await expect(
      provider.getBufferSnapshot('daemon-session', { scrollbackRows: 50_000 })
    ).resolves.toEqual(snapshot)
    expect(current.getBufferSnapshot).toHaveBeenCalledWith('daemon-session', {
      scrollbackRows: 50_000
    })
  })

  it('forwards replay output from fallback and daemon providers', () => {
    const current = createDaemonAdapter('daemon')
    const fallback = createProvider('fallback')
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })
    const replaySpy = vi.fn()

    const unsubscribe = provider.onReplay(replaySpy)
    current.emitReplay('daemon-session', 'daemon replay')
    fallback.emitReplay('fallback-session', 'fallback replay')
    unsubscribe()
    current.emitReplay('daemon-session', 'after unsubscribe')

    expect(replaySpy).toHaveBeenCalledTimes(2)
    expect(replaySpy).toHaveBeenNthCalledWith(1, {
      id: 'daemon-session',
      data: 'daemon replay'
    })
    expect(replaySpy).toHaveBeenNthCalledWith(2, {
      id: 'fallback-session',
      data: 'fallback replay'
    })
  })

  it('preserves explicit sequence accounting on daemon data events', () => {
    const current = createDaemonAdapter('daemon')
    const fallback = createProvider('fallback')
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })
    const dataSpy = vi.fn()
    provider.onData(dataSpy)

    current.emitData('daemon-session', '\x1b[6n', 0)

    expect(dataSpy).toHaveBeenCalledWith({
      id: 'daemon-session',
      data: '\x1b[6n',
      sequenceChars: 0
    })
  })

  it('detaches provider subscriptions without disposing the underlying providers', () => {
    const current = createDaemonAdapter('daemon')
    const fallback = createProvider('fallback')
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })
    const dataSpy = vi.fn()
    const exitSpy = vi.fn()
    provider.onData(dataSpy)
    provider.onExit(exitSpy)

    provider.disposeProviderOnly()
    current.emitData('daemon-session', 'data')
    fallback.emitExit('fallback-session', 0)

    expect(dataSpy).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
    expect(current.dispose).not.toHaveBeenCalled()
  })

  it('shuts down fallback sessions before a daemon-provider swap', async () => {
    const current = createDaemonAdapter('daemon')
    const fallback = createProvider('fallback')
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })

    const fresh = await provider.spawn({ cols: 80, rows: 24 })
    const killedCount = await provider.shutdownFallbackSessions()

    expect(killedCount).toBe(1)
    expect(fallback.shutdown).toHaveBeenCalledWith(fresh.id, { immediate: true })
    expect(provider.hasPty(fresh.id)).toBe(false)
  })

  it('is best-effort: counts only successful shutdowns and never throws (keeps restart alive)', async () => {
    const current = createDaemonAdapter('daemon')
    const fallback = createProvider('fallback')
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })
    const stuck = await provider.spawn({ sessionId: 'stuck', cols: 80, rows: 24 })
    await provider.spawn({ sessionId: 'ok', cols: 80, rows: 24 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(fallback.shutdown).mockImplementation(async (id: string) => {
      if (id === stuck.id) {
        throw new Error('still alive')
      }
    })

    // Why: a single un-killable local PTY must not abort the daemon restart.
    const killedCount = await provider.shutdownFallbackSessions()

    // Best-effort: the one that shut down is counted, the stuck one is not, and
    // crucially it does not throw — so the daemon restart sequence proceeds.
    expect(killedCount).toBe(1)
    expect(warn).toHaveBeenCalled()
    expect(fallback.shutdown).toHaveBeenCalledWith('stuck', { immediate: true })
    expect(fallback.shutdown).toHaveBeenCalledWith('ok', { immediate: true })
    warn.mockRestore()
  })

  it('fans synthetic exits for discovered current-daemon sessions only', async () => {
    const current = createDaemonAdapter('daemon', ['current-session'])
    const legacy = createDaemonAdapter('legacy', ['legacy-session'])
    const fallback = createProvider('fallback')
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [legacy], fallback })
    const exitSpy = vi.fn()
    provider.onExit(exitSpy)

    await provider.discoverDaemonSessions()
    provider.fanoutCurrentDaemonSyntheticExits(-1)

    expect(exitSpy).toHaveBeenCalledOnce()
    expect(exitSpy).toHaveBeenCalledWith({ id: 'current-session', code: -1 })
    expect(provider.getCurrentDaemonSessionIds()).toEqual([])
    expect(provider.hasPty('legacy-session')).toBe(true)
  })
})
