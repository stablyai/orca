import { describe, expect, it, vi } from 'vitest'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import { DEGRADED_DAEMON_RECOVERY_RETRY_MS } from './degraded-daemon-fresh-spawn-routing'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../providers/types'
import type { PtyProcessInspection } from '../providers/pty-process-inspection'
import { SessionNotFoundError, TerminalSessionOwnerUnverifiedError } from './daemon-errors'
import { isSshPtyNotFoundError } from '../providers/ssh-pty-errors'

type ProviderMock = IPtyProvider & {
  probePtyLiveness: (id: string) => Promise<boolean | null>
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
    probePtyLiveness: vi.fn(async (id: string) => sessions.includes(id)),
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
    supportsGitCredentialGuardHost: vi.fn(() => true),
    canProvideAuthoritativeBufferSnapshot: vi.fn(() => true),
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

it('routes attach-only to a legacy session created after startup inventory', async () => {
  const current = createDaemonAdapter('daemon')
  const legacySessions = ['legacy-at-startup']
  const legacy = createDaemonAdapter('legacy', legacySessions)
  const fallback = createProvider('fallback')
  const provider = new DegradedDaemonPtyProvider({
    current,
    legacy: [legacy],
    fallback
  })
  await provider.discoverDaemonSessions()
  legacySessions.push('legacy-created-later')

  await provider.spawn({
    sessionId: 'legacy-created-later',
    attachOnly: true,
    cols: 80,
    rows: 24
  })

  expect(legacy.spawn).toHaveBeenCalledOnce()
  expect(current.spawn).not.toHaveBeenCalled()
  expect(fallback.spawn).not.toHaveBeenCalled()
})

it('keeps an attach unresolved when a legacy inventory listing fails', async () => {
  const current = createDaemonAdapter('daemon')
  const legacy = createDaemonAdapter('legacy')
  vi.mocked(legacy.listProcesses).mockRejectedValue(new Error('wedged'))
  const provider = new DegradedDaemonPtyProvider({
    current,
    legacy: [legacy],
    fallback: createProvider('fallback')
  })

  await expect(
    provider.spawn({ sessionId: 'unknown-session', attachOnly: true, cols: 80, rows: 24 })
  ).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
  expect(current.spawn).not.toHaveBeenCalled()
})

it('confirms repeated stale-binding absence without falling back or spawning', async () => {
  const current = createDaemonAdapter('daemon-current')
  const legacy = createDaemonAdapter('daemon-legacy')
  const fallback = createProvider('local-fallback')
  vi.mocked(fallback.spawn).mockImplementation(async (opts) =>
    opts.attachOnly
      ? {
          id: opts.sessionId!,
          incarnationId: 'incarnation-fresh-local',
          isReattach: true
        }
      : { id: 'pty-fresh-local', incarnationId: 'incarnation-fresh-local' }
  )
  const provider = new DegradedDaemonPtyProvider({ current, legacy: [legacy], fallback })
  const attach = {
    sessionId: 'pty-persisted-missing',
    expectedIncarnationId: 'incarnation-persisted-missing',
    attachOnly: true,
    cols: 80,
    rows: 24
  } as const

  await expect(provider.spawn(attach)).rejects.toBeInstanceOf(SessionNotFoundError)
  await expect(provider.spawn(attach)).rejects.toBeInstanceOf(SessionNotFoundError)

  expect(fallback.listProcesses).toHaveBeenCalledTimes(2)
  expect(current.listProcesses).toHaveBeenCalledTimes(2)
  expect(legacy.listProcesses).toHaveBeenCalledTimes(2)
  expect(fallback.spawn).not.toHaveBeenCalled()
  expect(current.spawn).not.toHaveBeenCalled()
  expect(legacy.spawn).not.toHaveBeenCalled()

  const fresh = await provider.spawn({ cols: 80, rows: 24 })
  await expect(
    provider.spawn({
      sessionId: fresh.id,
      expectedIncarnationId: fresh.incarnationId,
      attachOnly: true,
      cols: 80,
      rows: 24
    })
  ).resolves.toMatchObject({
    id: 'pty-fresh-local',
    incarnationId: 'incarnation-fresh-local',
    isReattach: true
  })

  expect(fallback.spawn).toHaveBeenCalledTimes(2)
  expect(vi.mocked(fallback.spawn).mock.calls[0]?.[0]).not.toHaveProperty('sessionId')
  expect(vi.mocked(fallback.spawn).mock.calls[1]?.[0]).toMatchObject({
    sessionId: 'pty-fresh-local',
    attachOnly: true
  })
  expect(current.spawn).not.toHaveBeenCalled()
  expect(legacy.spawn).not.toHaveBeenCalled()
  expect(fallback.listProcesses).toHaveBeenCalledTimes(2)
  expect(current.listProcesses).toHaveBeenCalledTimes(2)
  expect(legacy.listProcesses).toHaveBeenCalledTimes(2)
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
  it('refuses attach for ids no daemon adapter owns instead of the fallback no-op', async () => {
    const daemonSessions: string[] = []
    const current = createDaemonAdapter('daemon', daemonSessions)
    const fallback = createProvider('fallback', ['fresh-fallback-session'])
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })

    // Unknown id: the fallback's resolving no-op attach must never read as
    // success — the runtime would pin a blank stream as attached.
    await expect(provider.attach('wt-1@@unknown')).rejects.toThrow(
      'Session not found: wt-1@@unknown'
    )
    // Fallback-owned fresh sessions stream in-process; attach is refused too.
    await expect(provider.attach('fresh-fallback-session')).rejects.toThrow(
      'Session not found: fresh-fallback-session'
    )
    expect(fallback.attach).not.toHaveBeenCalled()
    expect(current.attach).not.toHaveBeenCalled()

    // Once a daemon adapter owns the id, attach routes to that adapter.
    daemonSessions.push('wt-1@@learned')
    await expect(provider.attach('wt-1@@learned')).resolves.toBeUndefined()
    expect(current.attach).toHaveBeenCalledWith('wt-1@@learned')
    expect(fallback.attach).not.toHaveBeenCalled()
  })

  it('forwards the owning daemon sequence from attach', async () => {
    const legacy = createDaemonAdapter('legacy', ['daemon-session'])
    const providerSequence = { value: 204, generation: 'continued' as const }
    vi.mocked(legacy.attach).mockResolvedValueOnce({ providerSequence })
    const provider = new DegradedDaemonPtyProvider({
      current: createDaemonAdapter('current'),
      legacy: [legacy],
      fallback: createProvider('fallback')
    })
    await provider.discoverDaemonSessions()

    await expect(provider.attach('daemon-session')).resolves.toEqual({ providerSequence })
  })

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

  it('routes later fresh PTYs to the daemon after spawn health recovers', async () => {
    const current = createDaemonAdapter('daemon')
    const fallback = createProvider('fallback')
    const probeCurrentDaemonSpawn = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const provider = new DegradedDaemonPtyProvider({
      current,
      legacy: [],
      fallback,
      probeCurrentDaemonSpawn
    })
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)

    try {
      await expect(provider.recoverFreshSpawnRouting()).resolves.toBe(false)
      await provider.spawn({ cols: 80, rows: 24 })
      await expect(provider.recoverFreshSpawnRouting()).resolves.toBe(false)
      expect(probeCurrentDaemonSpawn).toHaveBeenCalledOnce()
      now.mockReturnValue(1_000 + DEGRADED_DAEMON_RECOVERY_RETRY_MS)
      await expect(provider.recoverFreshSpawnRouting()).resolves.toBe(true)
      const recovered = await provider.spawn({ cols: 80, rows: 24, worktreeId: 'wt-1' })

      expect(provider.routesFreshSpawnsToLocalProvider).toBeUndefined()
      expect(provider.isDegraded).toBe(true)
      expect(provider.supportsGitCredentialGuardHost()).toBe(true)
      expect(fallback.spawn).toHaveBeenCalledOnce()
      expect(current.spawn).toHaveBeenCalledWith({ cols: 80, rows: 24, worktreeId: 'wt-1' })
      expect(recovered.id).toBe('daemon-new')
      expect(provider.canProvideAuthoritativeBufferSnapshot(recovered.id)).toBe(true)
    } finally {
      now.mockRestore()
    }
  })

  it('coalesces concurrent fresh-spawn recovery probes', async () => {
    let resolveProbe: ((healthy: boolean) => void) | undefined
    const probeCurrentDaemonSpawn = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve
        })
    )
    const provider = new DegradedDaemonPtyProvider({
      current: createDaemonAdapter('daemon'),
      legacy: [],
      fallback: createProvider('fallback'),
      probeCurrentDaemonSpawn
    })

    const first = provider.recoverFreshSpawnRouting()
    const second = provider.recoverFreshSpawnRouting()
    expect(probeCurrentDaemonSpawn).toHaveBeenCalledOnce()
    resolveProbe?.(true)

    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    await expect(provider.recoverFreshSpawnRouting()).resolves.toBe(true)
    expect(probeCurrentDaemonSpawn).toHaveBeenCalledOnce()
  })

  it('does not retain recovered daemon ownership after exit beats the spawn reply', async () => {
    const current = createDaemonAdapter('daemon')
    const provider = new DegradedDaemonPtyProvider({
      current,
      legacy: [],
      fallback: createProvider('fallback'),
      probeCurrentDaemonSpawn: vi.fn(async () => true)
    })
    vi.mocked(current.spawn).mockImplementation(async () => {
      current.emitExit('daemon-fast-exit', 0)
      return { id: 'daemon-fast-exit', exitedBeforeSpawnReply: true }
    })

    await provider.recoverFreshSpawnRouting()
    await expect(provider.spawn({ cols: 80, rows: 24 })).resolves.toMatchObject({
      id: 'daemon-fast-exit',
      exitedBeforeSpawnReply: true
    })

    expect(provider.getCurrentDaemonSessionIds()).toEqual([])
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

  // Why: while degraded, a provider that cannot answer must not let inspection
  // manufacture terminal_gone — that verdict retires a pane that may still be live.
  it('answers unknown, and refuses terminal_gone, when no provider can answer', async () => {
    const current = createDaemonAdapter('daemon')
    const fallback = createProvider('fallback')
    current.hasPty = vi.fn(() => null)
    fallback.hasPty = vi.fn(() => null)
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })

    expect(provider.hasPty('unmapped-session')).toBe(null)
    await expect(provider.inspectProcess('unmapped-session')).resolves.toEqual({
      foregroundProcess: null,
      hasChildProcesses: false
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

  it('probes daemon owners without borrowing fallback liveness', async () => {
    const currentSessions: string[] = []
    const current = createDaemonAdapter('current', currentSessions)
    const legacy = createDaemonAdapter('legacy')
    const fallback = createProvider('fallback', ['unknown-session'])
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [legacy], fallback })
    vi.mocked(legacy.listProcesses).mockRejectedValue(new Error('legacy inventory unavailable'))

    await expect(provider.probePtyLiveness('unknown-session')).resolves.toBeNull()
    expect(fallback.probePtyLiveness).not.toHaveBeenCalled()

    currentSessions.push('unknown-session')
    await expect(provider.probePtyLiveness('unknown-session')).resolves.toBe(true)
  })

  it('reports a routed fallback PTY live before probing daemon absence', async () => {
    const current = createDaemonAdapter('current')
    const legacy = createDaemonAdapter('legacy')
    const fallback = createProvider('fallback')
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [legacy], fallback })
    const fresh = await provider.spawn({ cols: 80, rows: 24 })

    await expect(provider.probePtyLiveness(fresh.id)).resolves.toBe(true)
    expect(fallback.hasPty).toHaveBeenCalledWith(fresh.id)
    expect(current.listProcesses).not.toHaveBeenCalled()
    expect(legacy.listProcesses).not.toHaveBeenCalled()
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

  it('routes every session operation for a mapped daemon session to that adapter', async () => {
    const current = createDaemonAdapter('daemon', ['daemon-session'])
    const fallback = createProvider('fallback')
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })
    await provider.discoverDaemonSessions()

    provider.write('daemon-session', 'ls\n')
    provider.resize('daemon-session', 120, 40)
    await provider.sendSignal('daemon-session', 'SIGINT')
    await provider.shutdown('daemon-session', {})

    expect(current.write).toHaveBeenCalledWith('daemon-session', 'ls\n')
    expect(current.resize).toHaveBeenCalledWith('daemon-session', 120, 40)
    expect(current.sendSignal).toHaveBeenCalledWith('daemon-session', 'SIGINT')
    expect(current.shutdown).toHaveBeenCalledWith('daemon-session', {})
    expect(fallback.write).not.toHaveBeenCalled()
    expect(fallback.resize).not.toHaveBeenCalled()
    expect(fallback.sendSignal).not.toHaveBeenCalled()
    expect(fallback.shutdown).not.toHaveBeenCalled()
  })

  it('keeps an exited legacy daemon poisoning listProcesses after construction', async () => {
    const current = createDaemonAdapter('daemon', ['current-session'])
    const legacy = createDaemonAdapter('legacy', ['legacy-session'])
    const fallback = createProvider('fallback', ['fallback-session'])
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [legacy], fallback })
    await provider.discoverDaemonSessions()
    vi.mocked(legacy.listProcesses).mockRejectedValue(new Error('legacy exited'))

    await expect(provider.listProcesses()).rejects.toThrow('legacy exited')
    await expect(provider.listProcesses()).rejects.toThrow('legacy exited')
    expect(provider.getLegacyAdapters()).toEqual([legacy])
    expect(current.listProcesses).toHaveBeenCalledTimes(3)
    expect(fallback.listProcesses).toHaveBeenCalledTimes(3)
  })
})

describe('DegradedDaemonPtyProvider owner gate against an unanswerable fallback', () => {
  // STA-3077 made hasPty three-valued: null now means "this provider cannot answer", where
  // before the only answers were yes and no. The owner gate asks the fallback to *prove* it owns
  // a session before letting it act, and it must read that new null as "not proven" — otherwise
  // the in-process fallback answers for a daemon-owned session, the pane closes, and the agent
  // keeps running as an orphan. Nothing else exercises null at this boundary: every other double
  // answers false, which makes `!== true` and `=== false` indistinguishable.
  it('refuses a mutating operation when the fallback cannot answer for the session', async () => {
    const current = createDaemonAdapter('daemon')
    const fallback = createProvider('fallback')
    fallback.hasPty = vi.fn(() => null)
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })

    await expect(provider.shutdown('wt-1@@unanswerable', {})).rejects.toBeInstanceOf(
      TerminalSessionOwnerUnverifiedError
    )
    expect(fallback.shutdown).not.toHaveBeenCalled()
    expect(current.shutdown).not.toHaveBeenCalled()
  })

  it('still lets the fallback act on a session it positively claims', async () => {
    const current = createDaemonAdapter('daemon')
    const fallback = createProvider('fallback')
    fallback.hasPty = vi.fn(() => true)
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })

    await provider.shutdown('wt-1@@local', {})
    expect(fallback.shutdown).toHaveBeenCalledWith('wt-1@@local', {})
  })
})

describe('DegradedDaemonPtyProvider with a held daemon', () => {
  const HELD_SESSION = 'wt-1@@held-daemon-session'

  /** Held launch mode never connects to the wedged daemon, so discovery maps nothing and
   *  every daemon-owned id is unrouted — i.e. resolves to the in-process fallback. */
  function createHeldDaemonProvider(): {
    current: ReturnType<typeof createDaemonAdapter>
    fallback: ReturnType<typeof createProvider>
    provider: DegradedDaemonPtyProvider
  } {
    const current = createDaemonAdapter('daemon')
    const fallback = createProvider('fallback')
    return {
      current,
      fallback,
      provider: new DegradedDaemonPtyProvider({ current, legacy: [], fallback })
    }
  }

  it('rejects shutdown for a held daemon session instead of reporting a silent success', async () => {
    const { current, fallback, provider } = createHeldDaemonProvider()
    await provider.discoverDaemonSessions()

    // Why: the fallback's shutdown resolves for ids it never had, so the pane would close
    // while the daemon's agent keeps running as an orphan.
    await expect(provider.shutdown(HELD_SESSION, {})).rejects.toBeInstanceOf(
      TerminalSessionOwnerUnverifiedError
    )
    expect(fallback.shutdown).not.toHaveBeenCalled()
    expect(current.shutdown).not.toHaveBeenCalled()
  })

  it('does not let the kill path mistake an unreachable owner for an already-gone pty', async () => {
    const { provider } = createHeldDaemonProvider()
    await provider.discoverDaemonSessions()
    // Mirrors pty:kill's isPtyAlreadyGoneError (src/main/ipc/pty.ts), which is not exported:
    // any error matching it is swallowed into a synthesized pty:exit and reported as success —
    // exactly the orphan-hiding lie this routing exists to prevent. Renaming the thrown error
    // back into that shape would silently reintroduce it.
    const looksAlreadyGoneToPtyKill = (error: unknown): boolean =>
      isSshPtyNotFoundError(error) ||
      /Session not found/i.test(error instanceof Error ? error.message : String(error))

    const error = await provider.shutdown(HELD_SESSION, {}).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
    expect(looksAlreadyGoneToPtyKill(error)).toBe(false)
  })

  it('throws on write and resize for a held daemon session instead of swallowing input', async () => {
    const { fallback, provider } = createHeldDaemonProvider()
    await provider.discoverDaemonSessions()

    // Why: the fallback's write/resize are `ptyProcesses.get(id)?.…` — typing would vanish.
    expect(() => provider.write(HELD_SESSION, 'ls\n')).toThrow(TerminalSessionOwnerUnverifiedError)
    expect(() => provider.resize(HELD_SESSION, 120, 40)).toThrow(
      TerminalSessionOwnerUnverifiedError
    )
    expect(fallback.write).not.toHaveBeenCalled()
    expect(fallback.resize).not.toHaveBeenCalled()
  })

  it('rejects sendSignal for a held daemon session', async () => {
    const { fallback, provider } = createHeldDaemonProvider()
    await provider.discoverDaemonSessions()

    await expect(provider.sendSignal(HELD_SESSION, 'SIGINT')).rejects.toBeInstanceOf(
      TerminalSessionOwnerUnverifiedError
    )
    expect(fallback.sendSignal).not.toHaveBeenCalled()
  })

  it('keeps refusing attach for a held daemon session', async () => {
    const { fallback, provider } = createHeldDaemonProvider()
    await provider.discoverDaemonSessions()

    await expect(provider.attach(HELD_SESSION)).rejects.toBeInstanceOf(SessionNotFoundError)
    expect(fallback.attach).not.toHaveBeenCalled()
  })

  it('still routes every operation for a locally spawned session the fallback owns', async () => {
    const { current, fallback, provider } = createHeldDaemonProvider()
    await provider.discoverDaemonSessions()
    const fresh = await provider.spawn({ cols: 80, rows: 24 })

    provider.write(fresh.id, 'echo hi\n')
    provider.resize(fresh.id, 100, 30)
    await expect(provider.sendSignal(fresh.id, 'SIGINT')).resolves.toBeUndefined()
    await expect(provider.shutdown(fresh.id, {})).resolves.toBeUndefined()

    expect(fallback.write).toHaveBeenCalledWith(fresh.id, 'echo hi\n')
    expect(fallback.resize).toHaveBeenCalledWith(fresh.id, 100, 30)
    expect(fallback.sendSignal).toHaveBeenCalledWith(fresh.id, 'SIGINT')
    expect(fallback.shutdown).toHaveBeenCalledWith(fresh.id, {})
    expect(current.write).not.toHaveBeenCalled()
    expect(current.shutdown).not.toHaveBeenCalled()
  })
})

// A memoized route outlives the session it was established for: listProcesses
// drops ids missing from an authoritative inventory without an exit fanout. So a
// mapped owner that cannot answer must stay unknown — coercing it to a liveness
// proof is worse than the absence it replaced, because callers skip the real probe.
it('keeps a mapped owner that cannot answer unknown, and still probes', async () => {
  const current = createDaemonAdapter('current', ['s1'])
  const fallback = createProvider('fallback')
  const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })

  expect(provider.hasPty('s1')).toBe(true)

  current.hasPty = vi.fn(() => null)
  expect(provider.hasPty('s1')).toBeNull()

  current.probePtyLiveness = vi.fn(async () => null)
  await provider.probePtyLiveness('s1')
  expect(current.probePtyLiveness).toHaveBeenCalled()
})
