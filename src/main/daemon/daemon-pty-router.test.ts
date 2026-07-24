import { describe, expect, it, vi } from 'vitest'
import { DaemonPtyRouter } from './daemon-pty-router'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { PtyBackgroundStreamEvent, PtySpawnOptions, PtySpawnResult } from '../providers/types'
import {
  AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION,
  AGENT_SESSION_CREATE_OPERATION_DAEMON_PROTOCOL_VERSION,
  GIT_CREDENTIAL_GUARD_HOST_PROTOCOL_VERSION
} from './types'

type AdapterMock = DaemonPtyAdapter & {
  emitData: (id: string, data: string, sequenceChars?: number) => void
  emitBackground: (event: PtyBackgroundStreamEvent) => void
  emitExit: (id: string, code: number, incarnationId?: string) => void
}

const LARGE_RECONCILE_SESSION_COUNT = 150_000

function buildSessionIds(prefix: string, count: number): string[] {
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    ids.push(`${prefix}-${index}`)
  }
  return ids
}

function createAdapter(
  label: string,
  sessions: string[] = [],
  reconcileResult?: { alive: string[]; killed: string[] },
  protocolVersion = GIT_CREDENTIAL_GUARD_HOST_PROTOCOL_VERSION
): AdapterMock {
  const writes: { id: string; data: string }[] = []
  const dataListeners: ((payload: { id: string; data: string; sequenceChars?: number }) => void)[] =
    []
  const backgroundListeners: ((payload: PtyBackgroundStreamEvent) => void)[] = []
  const exitListeners: ((payload: { id: string; code: number; incarnationId?: string }) => void)[] =
    []
  return {
    protocolVersion,
    supportsGitCredentialGuardHost: () =>
      protocolVersion >= GIT_CREDENTIAL_GUARD_HOST_PROTOCOL_VERSION,
    supportsAgentSessionClaims: () =>
      protocolVersion >= AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION,
    supportsAgentSessionCreateOperations: () =>
      protocolVersion >= AGENT_SESSION_CREATE_OPERATION_DAEMON_PROTOCOL_VERSION,
    providesAgentSessionOwnerListings: () =>
      protocolVersion >= AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION,
    canProvideAuthoritativeBufferSnapshot: () => protocolVersion >= 20,
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
    hasPty: vi.fn((id: string) => sessions.includes(id)),
    write: vi.fn((id: string, data: string) => {
      writes.push({ id, data })
    }),
    resize: vi.fn(),
    setPtyBackgrounded: vi.fn(),
    getBufferSnapshot: vi.fn(async () => null),
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
    inspectProcess: vi.fn(async () => ({ foregroundProcess: null, hasChildProcesses: false })),
    confirmForegroundProcess: vi.fn(async () => `${label}-confirmed`),
    serialize: vi.fn(async () => '{}'),
    revive: vi.fn(async () => {}),
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
    onBackgroundStreamEvent: vi.fn((callback: (payload: PtyBackgroundStreamEvent) => void) => {
      backgroundListeners.push(callback)
      return () => {
        const idx = backgroundListeners.indexOf(callback)
        if (idx !== -1) {
          backgroundListeners.splice(idx, 1)
        }
      }
    }),
    onExit: vi.fn(
      (callback: (payload: { id: string; code: number; incarnationId?: string }) => void) => {
        exitListeners.push(callback)
        return () => {
          const idx = exitListeners.indexOf(callback)
          if (idx !== -1) {
            exitListeners.splice(idx, 1)
          }
        }
      }
    ),
    ackColdRestore: vi.fn(),
    clearTombstone: vi.fn(),
    reconcileOnStartup: vi.fn(async () => reconcileResult ?? { alive: sessions, killed: [] }),
    dispose: vi.fn(),
    disconnectOnly: vi.fn(async () => {}),
    emitData: (id: string, data: string, sequenceChars?: number) => {
      for (const listener of dataListeners) {
        listener({ id, data, ...(sequenceChars === undefined ? {} : { sequenceChars }) })
      }
    },
    emitBackground: (event: PtyBackgroundStreamEvent) => {
      for (const listener of backgroundListeners) {
        listener(event)
      }
    },
    emitExit: (id: string, code: number, incarnationId?: string) => {
      for (const listener of exitListeners) {
        listener({ id, code, ...(incarnationId ? { incarnationId } : {}) })
      }
    },
    _writes: writes
  } as unknown as AdapterMock
}

it('rejects completion inspection when no daemon owns the session', async () => {
  const router = new DaemonPtyRouter({
    current: createAdapter('current'),
    legacy: [createAdapter('legacy')]
  })

  await expect(router.inspectProcess('unmapped-session')).rejects.toThrow('terminal_gone')
})

describe('DaemonPtyRouter', () => {
  it('reports separate conservative resume and fresh-create boundaries', () => {
    const current = createAdapter(
      'current',
      [],
      undefined,
      AGENT_SESSION_CREATE_OPERATION_DAEMON_PROTOCOL_VERSION
    )
    const legacy = createAdapter(
      'legacy',
      [],
      undefined,
      AGENT_SESSION_CREATE_OPERATION_DAEMON_PROTOCOL_VERSION - 1
    )
    const mixed = new DaemonPtyRouter({ current, legacy: [legacy] })
    const old = new DaemonPtyRouter({ current: legacy, legacy: [] })

    expect(mixed.supportsAgentSessionClaims()).toBe(false)
    expect(mixed.supportsAgentSessionCreateOperations()).toBe(true)
    expect(old.supportsAgentSessionClaims()).toBe(false)
    expect(old.supportsAgentSessionCreateOperations()).toBe(false)
  })

  it('only treats owner listings as authoritative for a mapped daemon route', async () => {
    const current = createAdapter(
      'current',
      [],
      undefined,
      AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION
    )
    const legacy = createAdapter(
      'legacy',
      ['legacy-session'],
      undefined,
      AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION
    )
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()
    const created = await router.spawn({ cols: 80, rows: 24 })

    expect(router.providesAgentSessionOwnerListings('legacy-session')).toBe(true)
    expect(router.providesAgentSessionOwnerListings(created.id)).toBe(true)
    expect(router.providesAgentSessionOwnerListings('unknown-session')).toBe(false)
  })

  it('does not publish a route when the adapter proves exit before reply', async () => {
    const current = createAdapter('current')
    let finishSpawn: ((result: PtySpawnResult) => void) | undefined
    vi.mocked(current.spawn).mockImplementation(
      () =>
        new Promise<PtySpawnResult>((resolve) => {
          finishSpawn = resolve
        })
    )
    const router = new DaemonPtyRouter({ current, legacy: [] })

    const spawning = router.spawn({ cols: 80, rows: 24, sessionId: 'raced-session' })
    finishSpawn?.({
      id: 'raced-session',
      incarnationId: 'raced-incarnation',
      exitedBeforeSpawnReply: true
    })
    await expect(spawning).resolves.toMatchObject({ exitedBeforeSpawnReply: true })

    const internals = router as unknown as {
      sessionAdapters: Map<string, DaemonPtyAdapter>
    }
    expect(internals.sessionAdapters.has('raced-session')).toBe(false)
  })

  it('routes a replacement when only an older incarnation exits during spawn', async () => {
    const current = createAdapter('current')
    let finishSpawn: ((result: PtySpawnResult) => void) | undefined
    vi.mocked(current.spawn).mockImplementation(
      () =>
        new Promise<PtySpawnResult>((resolve) => {
          finishSpawn = resolve
        })
    )
    const router = new DaemonPtyRouter({ current, legacy: [] })

    const spawning = router.spawn({ cols: 80, rows: 24, sessionId: 'reused-session' })
    current.emitExit('reused-session', 0, 'incarnation-old')
    finishSpawn?.({ id: 'reused-session', incarnationId: 'incarnation-current' })
    await spawning

    const internals = router as unknown as {
      sessionAdapters: Map<string, DaemonPtyAdapter>
    }
    expect(internals.sessionAdapters.get('reused-session')).toBe(current)
  })

  it('preserves canonical claimed-owner exit proof from the adapter', async () => {
    const current = createAdapter('current')
    let finishSpawn: ((result: PtySpawnResult) => void) | undefined
    vi.mocked(current.spawn).mockImplementation(
      () =>
        new Promise<PtySpawnResult>((resolve) => {
          finishSpawn = resolve
        })
    )
    const router = new DaemonPtyRouter({ current, legacy: [] })

    const spawning = router.spawn({
      cols: 80,
      rows: 24,
      sessionId: 'requested-session',
      agentSessionEnsure: {} as never
    })
    finishSpawn?.({
      id: 'canonical-session',
      incarnationId: 'canonical-incarnation',
      exitedBeforeSpawnReply: true
    })

    await expect(spawning).resolves.toMatchObject({
      id: 'canonical-session',
      exitedBeforeSpawnReply: true
    })
    const internals = router as unknown as {
      sessionAdapters: Map<string, DaemonPtyAdapter>
    }
    expect(internals.sessionAdapters.has('canonical-session')).toBe(false)
  })

  it('reports snapshot capability for the adapter that owns each session', async () => {
    const current = createAdapter('current', ['current-session'], undefined, 22)
    const legacy = createAdapter('legacy', ['legacy-session'], undefined, 19)
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()

    expect(router.canProvideAuthoritativeBufferSnapshot('current-session')).toBe(true)
    expect(router.canProvideAuthoritativeBufferSnapshot('legacy-session')).toBe(false)
  })

  it('reports guard-host support for the adapter that owns the session', async () => {
    const current = createAdapter('current', [], undefined, 22)
    const legacy = createAdapter('legacy', ['legacy-session'], undefined, 21)
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()

    expect(router.supportsGitCredentialGuardHost()).toBe(true)
    expect(router.supportsGitCredentialGuardHost('legacy-session')).toBe(false)
  })

  it('routes fresh foreground confirmation to the session-owning daemon', async () => {
    const current = createAdapter('current', ['current-session'])
    const legacy = createAdapter('legacy', ['legacy-session'])
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()

    await expect(router.confirmForegroundProcess('legacy-session')).resolves.toBe(
      'legacy-confirmed'
    )
    await expect(router.confirmForegroundProcess('current-session')).resolves.toBe(
      'current-confirmed'
    )
    expect(legacy.confirmForegroundProcess).toHaveBeenCalledWith('legacy-session')
    expect(current.confirmForegroundProcess).toHaveBeenCalledWith('current-session')
  })

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

  it('routes background hints and authoritative snapshots to the session owner', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', ['legacy-session'])
    const snapshot = {
      data: 'legacy frame',
      cols: 80,
      rows: 24,
      seq: 42,
      source: 'headless' as const
    }
    vi.mocked(legacy.getBufferSnapshot).mockResolvedValue(snapshot)
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()

    router.setPtyBackgrounded('legacy-session', true)
    await expect(
      router.getBufferSnapshot('legacy-session', { scrollbackRows: 50_000 })
    ).resolves.toEqual(snapshot)

    expect(legacy.setPtyBackgrounded).toHaveBeenCalledWith('legacy-session', true)
    expect(current.setPtyBackgrounded).not.toHaveBeenCalled()
    expect(legacy.getBufferSnapshot).toHaveBeenCalledWith('legacy-session', {
      scrollbackRows: 50_000
    })
  })

  it('forwards gap events and explicit sequence accounting from every adapter', () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy')
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    const dataSpy = vi.fn()
    const backgroundSpy = vi.fn()
    router.onData(dataSpy)
    router.onBackgroundStreamEvent(backgroundSpy)

    current.emitData('current-session', '\x1b[6n', 0)
    legacy.emitBackground({
      id: 'legacy-session',
      kind: 'dataGap',
      droppedChars: 512,
      sequenceChars: 508
    })

    expect(dataSpy).toHaveBeenCalledWith({
      id: 'current-session',
      data: '\x1b[6n',
      sequenceChars: 0
    })
    expect(backgroundSpy).toHaveBeenCalledWith({
      id: 'legacy-session',
      kind: 'dataGap',
      droppedChars: 512,
      sequenceChars: 508
    })
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

  it('uses mapped adapter liveness instead of routing-cache presence for hasPty', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', ['legacy-session'])
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })

    await router.discoverLegacySessions()
    expect(router.hasPty('legacy-session')).toBe(true)

    await router.shutdown('legacy-session', { keepHistory: true })

    expect(router.hasPty('legacy-session')).toBe(false)
    expect(current.hasPty).not.toHaveBeenCalledWith('legacy-session')
  })

  it('fails listProcesses closed when any routed adapter cannot list sessions', async () => {
    const current = createAdapter('current', ['current-session'])
    const legacy = createAdapter('legacy', ['legacy-session'])
    vi.mocked(legacy.listProcesses).mockRejectedValueOnce(new Error('legacy unavailable'))
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })

    await expect(router.listProcesses()).rejects.toThrow('legacy unavailable')
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

  it('merges large startup reconciliation results', async () => {
    const alive = buildSessionIds('alive', LARGE_RECONCILE_SESSION_COUNT)
    const killed = buildSessionIds('killed', LARGE_RECONCILE_SESSION_COUNT)
    const current = createAdapter('current', [], { alive, killed })
    const router = new DaemonPtyRouter({ current, legacy: [] })

    const result = await router.reconcileOnStartup(new Set(['wt']))

    expect(result.alive).toHaveLength(LARGE_RECONCILE_SESSION_COUNT)
    expect(result.killed).toHaveLength(LARGE_RECONCILE_SESSION_COUNT)
    expect(result.alive.at(-1)).toBe(`alive-${LARGE_RECONCILE_SESSION_COUNT - 1}`)
    expect(result.killed.at(-1)).toBe(`killed-${LARGE_RECONCILE_SESSION_COUNT - 1}`)
    router.write('alive-0', 'restored\n')
    expect(current.write).toHaveBeenCalledWith('alive-0', 'restored\n')
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
