import { describe, expect, it, vi } from 'vitest'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import { DEGRADED_DAEMON_RECOVERY_RETRY_MS } from './degraded-daemon-fresh-spawn-routing'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { settledWriteStub } from '../providers/settled-pty-write-stub'
import type {
  IPtyProvider,
  PtySpawnOptions,
  PtySpawnResult
} from '../providers/pty-provider-contract'
import type {
  PtyProcessInspection,
  PtyProcessInspectionOptions
} from '../providers/pty-process-inspection'
import { readLaunchedAgentForeground } from '../runtime/launched-agent-foreground'
import { SessionNotFoundError, TerminalSessionOwnerUnverifiedError } from './daemon-errors'

type ProviderMock = IPtyProvider & {
  probePtyLiveness: (id: string) => Promise<boolean | null>
  inspectProcess: (
    id: string,
    options?: PtyProcessInspectionOptions
  ) => Promise<PtyProcessInspection>
  emitData: (id: string, data: string, sequenceChars?: number) => void
  emitReplay: (id: string, data: string) => void
  emitExit: (id: string, code: number) => void
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
    writeWithSettlement: vi.fn(settledWriteStub()),
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
    resetInputModes: vi.fn(async () => {}),
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
    })
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

describe('DegradedDaemonPtyProvider', () => {
  it('refuses attach for ids no daemon adapter owns instead of the fallback no-op', async () => {
    const daemonSessions: string[] = []
    const current = createDaemonAdapter('daemon', daemonSessions)
    const fallback = createProvider('fallback', ['fresh-fallback-session'])
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })

    // A resolving fallback attach would pin a blank stream as successfully attached.
    await expect(provider.attach('wt-1@@unknown')).rejects.toThrow(
      'Session not found: wt-1@@unknown'
    )
    await expect(provider.attach('fresh-fallback-session')).rejects.toThrow(
      'Session not found: fresh-fallback-session'
    )
    expect(fallback.attach).not.toHaveBeenCalled()
    expect(current.attach).not.toHaveBeenCalled()

    daemonSessions.push('wt-1@@learned')
    await expect(provider.attach('wt-1@@learned')).resolves.toBeUndefined()
    expect(current.attach).toHaveBeenCalledWith('wt-1@@learned')
    expect(fallback.attach).not.toHaveBeenCalled()
  })

  it('only delegates owner-listing authority to the provider that owns the id', async () => {
    const current = createDaemonAdapter('daemon', ['daemon-session'])
    const fallback = createProvider('fallback', [], true)
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })
    await provider.discoverDaemonSessions()

    expect(provider.providesAgentSessionOwnerListings('daemon-session')).toBe(true)
    expect(provider.providesAgentSessionOwnerListings('unknown-session')).toBe(false)
  })

  it('observes an established fresh PTY while an unrelated legacy daemon is unreachable', async () => {
    const current = createDaemonAdapter('daemon')
    const legacy = createDaemonAdapter('legacy', ['unrelated'])
    const fallback = createProvider('fallback')
    const observation = {
      ptyId: 'fallback-new',
      ptyIncarnationId: 'inc',
      authorityGeneration: 'owner',
      observationEpoch: 1,
      capturedAgeMs: 0,
      verdict: 'observed' as const,
      source: 'pty-master' as const,
      foregroundKind: 'non-shell' as const,
      processName: 'claude'
    }
    Object.assign(fallback, { supportsForegroundObservation: () => true })
    vi.mocked(fallback.inspectProcess).mockResolvedValue({
      foregroundProcess: 'claude',
      hasChildProcesses: true,
      foregroundObservation: observation
    })
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [legacy], fallback })
    const fresh = await provider.spawn({ cols: 80, rows: 24 })
    vi.mocked(legacy.listProcesses).mockRejectedValue(new Error('unreachable'))
    const controller = {
      supportsForegroundObservation: (id: string) => provider.supportsForegroundObservation(id),
      inspectProcess: (id: string, options?: PtyProcessInspectionOptions) =>
        provider.inspectProcess(id, options),
      getForegroundProcess: (id: string) => provider.getForegroundProcess(id),
      listProcesses: (_host?: string, opts?: Parameters<IPtyProvider['listProcesses']>[0]) =>
        provider.listProcesses(opts)
    }

    await expect(
      readLaunchedAgentForeground(controller, { remote: false, windows: false }, fresh.id, 'claude')
    ).resolves.toBe('agent')
    expect(fallback.inspectProcess).toHaveBeenCalledWith(fresh.id, { foregroundOnly: true })
    // The target read skips the unrelated census; every other scoped read keeps it.
    await expect(
      provider.listProcesses({ ptyIds: [fresh.id], targetOwnerOnly: true })
    ).resolves.toMatchObject([{ id: fresh.id }])
    expect(legacy.listProcesses).not.toHaveBeenCalled()
    await expect(provider.listProcesses({ ptyIds: [fresh.id] })).rejects.toThrow()
    expect(provider.supportsForegroundObservation('unrouted')).toBe(false)
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

    expect(provider.getSessionIdsRoutedTo('current-daemon')).toEqual([])
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

    const killedCount = await provider.shutdownFallbackSessions()

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
    provider.fanoutCurrentDaemonSyntheticExits(-1, { replacedByRestart: true })

    expect(exitSpy).toHaveBeenCalledOnce()
    expect(exitSpy).toHaveBeenCalledWith({
      id: 'current-session',
      code: -1,
      replacedByRestart: true
    })
    expect(provider.getSessionIdsRoutedTo('current-daemon')).toEqual([])
    expect(provider.hasPty('legacy-session')).toBe(true)
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
