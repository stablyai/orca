import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonPtyRouter } from './daemon-pty-router'
import { createAdapter, identity } from './daemon-pty-router-routing-safety-fixture'

describe('DaemonPtyRouter routing safety', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not clone daemon identity for established stream chunks', () => {
    const current = createAdapter('current')
    const data = vi.fn()
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: []
    })
    router.onData(data)

    current.emitData('stream-session', 'first')
    vi.mocked(current.adapter.getLastAuthenticatedDaemonIdentity).mockClear()
    for (let index = 0; index < 100; index += 1) {
      current.emitData('stream-session', `chunk-${index}`)
    }

    expect(data).toHaveBeenCalledTimes(101)
    expect(current.adapter.getLastAuthenticatedDaemonIdentity).not.toHaveBeenCalled()
  })

  it('uses conclusive probes while fencing absence after a failed discovery', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', ['legacy-session'])
    vi.mocked(legacy.adapter.listProcesses).mockRejectedValueOnce(new Error('listing failed'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })

    await router.discoverLegacySessions()
    await expect(
      router.spawn({
        sessionId: 'fresh-session',
        isNewSession: true,
        cols: 80,
        rows: 24
      })
    ).resolves.toMatchObject({ id: 'fresh-session' })
    await expect(
      router.spawn({ sessionId: 'legacy-session', cols: 80, rows: 24 })
    ).resolves.toMatchObject({ id: 'legacy-session' })
    await expect(router.shutdown('missing-session', { immediate: true })).rejects.toThrow(
      'daemon_session_routing_unavailable'
    )

    await router.discoverLegacySessions()
    await expect(router.shutdown('missing-session', { immediate: true })).rejects.toThrow(
      'terminal_gone'
    )

    expect(current.adapter.spawn).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'fresh-session',
      isNewSession: true,
      cols: 80,
      rows: 24
    })
    expect(legacy.adapter.spawn).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'legacy-session',
      cols: 80,
      rows: 24
    })
  })

  it('keeps a history handoff fenced until the current owner produces output', async () => {
    const sessionId = 'history-handoff'
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', [sessionId])
    let resolveSpawn: ((result: { id: string }) => void) | undefined
    vi.mocked(current.adapter.spawn).mockReturnValue(
      new Promise((resolve) => {
        resolveSpawn = resolve
      })
    )
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })
    const data = vi.fn()
    router.onData(data)

    await router.discoverLegacySessions()
    await router.shutdown(sessionId, { immediate: true, keepHistory: true })
    expect(router.getSessionRouteState(sessionId)).toBe('unavailable')
    expect(router.supportsGitCredentialGuardHost(sessionId)).toBe(false)

    const spawning = router.spawn({ sessionId, cols: 80, rows: 24 })
    current.emitData(sessionId, 'restored frame')
    expect(data).toHaveBeenCalledExactlyOnceWith({ id: sessionId, data: 'restored frame' })

    resolveSpawn?.({ id: sessionId })
    await spawning
    expect(router.getSessionRouteState(sessionId)).toBe('owned')
  })

  it('preserves collision evidence during a history handoff', async () => {
    const sessionId = 'colliding-history-handoff'
    const currentSessions: string[] = []
    const current = createAdapter('current', currentSessions)
    const legacy = createAdapter('legacy', [sessionId])
    let resolveSpawn: ((result: { id: string }) => void) | undefined
    vi.mocked(current.adapter.spawn).mockReturnValue(
      new Promise((resolve) => {
        resolveSpawn = resolve
      })
    )
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })

    await router.discoverLegacySessions()
    await router.shutdown(sessionId, { immediate: true, keepHistory: true })
    const spawning = router.spawn({ sessionId, cols: 80, rows: 24 })
    legacy.emitData(sessionId, 'foreign frame')
    current.emitData(sessionId, 'restored frame')
    currentSessions.push(sessionId)
    resolveSpawn?.({ id: sessionId })
    await spawning

    expect(router.getSessionRouteState(sessionId)).toBe('ambiguous')
    await expect(router.sendSignal(sessionId, 'SIGTERM')).rejects.toThrow(
      'daemon_session_routing_unavailable'
    )
  })

  it('probes adapters outside an ambiguous route while discovery is incomplete', async () => {
    const sessionId = 'hidden-collision'
    const firstSessions = [sessionId]
    const current = createAdapter('current')
    const first = createAdapter('legacy-first', firstSessions)
    const second = createAdapter('legacy-second', [sessionId])
    const undiscovered = createAdapter('legacy-undiscovered', [sessionId])
    vi.mocked(undiscovered.adapter.listProcesses).mockRejectedValueOnce(
      new Error('listing unavailable')
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [first.adapter, second.adapter, undiscovered.adapter]
    })

    await router.discoverLegacySessions()
    firstSessions.splice(0)

    await expect(router.sendSignal(sessionId, 'SIGTERM')).rejects.toThrow(
      'daemon_session_routing_unavailable'
    )
    expect(second.adapter.sendSignal).not.toHaveBeenCalled()
    expect(undiscovered.adapter.sendSignal).not.toHaveBeenCalled()
  })

  it('probes every adapter before collapsing an ambiguous route', async () => {
    const sessionId = 'late-collision'
    const firstSessions = [sessionId]
    const lateSessions: string[] = []
    const current = createAdapter('current', [sessionId], {
      alive: [sessionId],
      killed: []
    })
    const first = createAdapter('legacy-first', firstSessions, {
      alive: [sessionId],
      killed: []
    })
    const late = createAdapter('legacy-late', lateSessions)
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [first.adapter, late.adapter]
    })

    await router.reconcileOnStartup(new Set())
    firstSessions.splice(0)
    lateSessions.push(sessionId)

    await expect(router.sendSignal(sessionId, 'SIGTERM')).rejects.toThrow(
      'daemon_session_routing_unavailable'
    )
    expect(current.adapter.sendSignal).not.toHaveBeenCalled()
    expect(first.adapter.sendSignal).not.toHaveBeenCalled()
    expect(late.adapter.sendSignal).not.toHaveBeenCalled()
  })

  it('fails existing operations unknown when an owner probe is inconclusive', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy')
    vi.mocked(legacy.adapter.probePtyLiveness).mockResolvedValue(null)
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })

    await expect(
      router.spawn({ sessionId: 'uncertain-session', cols: 80, rows: 24 })
    ).rejects.toThrow('daemon_session_routing_unavailable')
    await expect(router.shutdown('uncertain-session', { immediate: true })).rejects.toThrow(
      'daemon_session_routing_unavailable'
    )
    await expect(router.sendSignal('uncertain-session', 'SIGTERM')).rejects.toThrow(
      'daemon_session_routing_unavailable'
    )

    expect(current.adapter.spawn).not.toHaveBeenCalled()
    expect(current.adapter.shutdown).not.toHaveBeenCalled()
    expect(current.adapter.sendSignal).not.toHaveBeenCalled()
  })

  it('keeps inconclusive synchronous liveness non-authoritative', async () => {
    const sessionId = 'uncertain-liveness'
    const current = createAdapter('current')
    const legacy = createAdapter('legacy')
    vi.mocked(legacy.adapter.listProcesses).mockRejectedValueOnce(new Error('listing unavailable'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })

    await router.discoverLegacySessions()

    expect(() => router.hasPty(sessionId)).toThrow('daemon_session_routing_unavailable')

    legacy.emitExit(sessionId, 0)
    expect(() => router.hasPty(sessionId)).toThrow('daemon_session_routing_unavailable')
  })

  it('keeps replacement-owned synchronous liveness non-authoritative', async () => {
    const sessionId = 'replacement-liveness'
    const legacy = createAdapter('legacy', [sessionId])
    const router = new DaemonPtyRouter({
      current: createAdapter('current').adapter,
      legacy: [legacy.adapter]
    })

    await router.discoverLegacySessions()
    legacy.setIdentity(identity('legacy', 11))

    expect(() => router.hasPty(sessionId)).toThrow('daemon_session_routing_unavailable')
    expect(legacy.adapter.hasPty).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent owner probes and memoizes the unique owner', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', ['surviving-session'])
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })

    await Promise.all([
      router.sendSignal('surviving-session', 'SIGINT'),
      router.shutdown('surviving-session', { immediate: true })
    ])

    expect(current.adapter.probePtyLiveness).toHaveBeenCalledExactlyOnceWith('surviving-session')
    expect(legacy.adapter.probePtyLiveness).toHaveBeenCalledExactlyOnceWith('surviving-session')
    expect(legacy.adapter.sendSignal).toHaveBeenCalledWith('surviving-session', 'SIGINT')
    expect(legacy.adapter.shutdown).toHaveBeenCalledWith('surviving-session', {
      immediate: true
    })
  })

  it('keeps cross-generation id collisions ambiguous and away from current', async () => {
    const sessionId = 'colliding-session'
    const current = createAdapter('current', [sessionId], {
      alive: [sessionId],
      killed: []
    })
    const legacy = createAdapter('legacy', [sessionId], {
      alive: [sessionId],
      killed: []
    })
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })

    await router.reconcileOnStartup(new Set())
    expect(router.getSessionRouteState(sessionId)).toBe('ambiguous')
    await expect(router.spawn({ sessionId, cols: 80, rows: 24 })).rejects.toThrow(
      'daemon_session_routing_unavailable'
    )
    await expect(router.shutdown(sessionId, { immediate: true })).rejects.toThrow(
      'daemon_session_routing_unavailable'
    )

    expect(current.adapter.spawn).not.toHaveBeenCalled()
    expect(current.adapter.shutdown).not.toHaveBeenCalled()
  })

  it('collapses an ambiguous route after one daemon incarnation is replaced', async () => {
    const sessionId = 'replaced-collision'
    const current = createAdapter('current', [sessionId], {
      alive: [sessionId],
      killed: []
    })
    const legacy = createAdapter('legacy', [sessionId], {
      alive: [sessionId],
      killed: []
    })
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })
    const previous = identity('legacy', 10)
    const replacement = identity('legacy', 11)

    await router.reconcileOnStartup(new Set())
    legacy.setIdentity(replacement)
    legacy.emitIdentityChange(previous, replacement)

    expect(router.getSessionRouteState(sessionId)).toBe('owned')
    await router.sendSignal(sessionId, 'SIGTERM')
    expect(current.adapter.sendSignal).toHaveBeenCalledExactlyOnceWith(sessionId, 'SIGTERM')
    expect(legacy.adapter.sendSignal).not.toHaveBeenCalled()
  })

  it('does not collapse an ambiguous route onto a replacement incarnation', async () => {
    const sessionId = 'replacement-collision'
    const currentSessions = [sessionId]
    const current = createAdapter('current', currentSessions, {
      alive: [sessionId],
      killed: []
    })
    const legacy = createAdapter('legacy', [sessionId], {
      alive: [sessionId],
      killed: []
    })
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })

    await router.reconcileOnStartup(new Set())
    currentSessions.splice(0)
    legacy.setIdentity(identity('legacy', 11))

    await expect(router.sendSignal(sessionId, 'SIGTERM')).rejects.toThrow(
      'daemon_session_routing_unavailable'
    )
    expect(current.adapter.sendSignal).not.toHaveBeenCalled()
    expect(legacy.adapter.sendSignal).not.toHaveBeenCalled()
  })

  it('does not admit a replacement ambiguous candidate after the other owner exits', async () => {
    const sessionId = 'stale-identity-collision'
    const current = createAdapter('current', [sessionId], {
      alive: [sessionId],
      killed: []
    })
    const legacy = createAdapter('legacy', [sessionId], {
      alive: [sessionId],
      killed: []
    })
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })
    const previous = identity('legacy', 10)
    const replacement = identity('legacy', 11)

    await router.reconcileOnStartup(new Set())
    legacy.setIdentity(replacement)
    await router.discoverLegacySessions()
    legacy.emitIdentityChange(previous, replacement)
    current.emitExit(sessionId, 0)

    expect(router.getSessionRouteState(sessionId)).toBe('unavailable')
    await expect(router.sendSignal(sessionId, 'SIGTERM')).rejects.toThrow(
      'daemon_session_routing_unavailable'
    )
    expect(current.adapter.sendSignal).not.toHaveBeenCalled()
    expect(legacy.adapter.sendSignal).not.toHaveBeenCalled()
  })

  it('does not transfer an owned route from replacement output', async () => {
    const sessionId = 'replacement-output'
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', [sessionId])
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })
    const data = vi.fn()
    router.onData(data)

    await router.discoverLegacySessions()
    legacy.setIdentity(identity('legacy', 11))
    legacy.emitData(sessionId, 'replacement frame')

    expect(data).not.toHaveBeenCalled()
    expect(router.getSessionRouteState(sessionId)).toBe('unavailable')
    await expect(router.sendSignal(sessionId, 'SIGTERM')).rejects.toThrow(
      'daemon_session_routing_unavailable'
    )
  })

  it('rejects an owner probe whose daemon incarnation changes in flight', async () => {
    const sessionId = 'probe-replacement-race'
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', [sessionId])
    let finishProbe: ((result: boolean) => void) | undefined
    vi.mocked(legacy.adapter.probePtyLiveness).mockReturnValue(
      new Promise((resolve) => {
        finishProbe = resolve
      })
    )
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })
    const previous = identity('legacy', 10)
    const replacement = identity('legacy', 11)

    const signaling = router.sendSignal(sessionId, 'SIGTERM')
    await vi.waitFor(() => expect(finishProbe).toBeDefined())
    legacy.setIdentity(replacement)
    legacy.emitIdentityChange(previous, replacement)
    finishProbe?.(true)

    await expect(signaling).rejects.toThrow('daemon_session_routing_unavailable')
    expect(current.adapter.sendSignal).not.toHaveBeenCalled()
    expect(legacy.adapter.sendSignal).not.toHaveBeenCalled()
  })

  it('rejects a liveness result when ownership changes in flight', async () => {
    const sessionId = 'stale-owned-liveness'
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', [sessionId])
    let finishProbe: ((result: boolean) => void) | undefined
    vi.mocked(legacy.adapter.probePtyLiveness).mockReturnValue(
      new Promise((resolve) => {
        finishProbe = resolve
      })
    )
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })

    await router.discoverLegacySessions()
    const probing = router.probePtyLiveness(sessionId)
    await vi.waitFor(() => expect(finishProbe).toBeDefined())
    current.emitData(sessionId, 'colliding frame')
    finishProbe?.(false)

    await expect(probing).resolves.toBeNull()
    expect(router.getSessionRouteState(sessionId)).toBe('ambiguous')
  })

  it('does not apply reconciliation after an earlier adapter is replaced', async () => {
    const sessionId = 'stale-reconciliation'
    const current = createAdapter('current', [], {
      alive: [sessionId],
      killed: []
    })
    const legacy = createAdapter('legacy')
    let finishLegacyReconciliation:
      | ((result: { alive: string[]; killed: string[] }) => void)
      | undefined
    vi.mocked(legacy.adapter.reconcileOnStartup).mockReturnValue(
      new Promise((resolve) => {
        finishLegacyReconciliation = resolve
      })
    )
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })
    const previous = identity('current', 20)
    const replacement = identity('current', 21)

    const reconciling = router.reconcileOnStartup(new Set())
    await vi.waitFor(() => expect(finishLegacyReconciliation).toBeDefined())
    current.setIdentity(replacement)
    current.emitIdentityChange(previous, replacement)
    await router.spawn({
      sessionId,
      isNewSession: true,
      cols: 80,
      rows: 24
    })
    finishLegacyReconciliation?.({ alive: [], killed: [] })

    await expect(reconciling).rejects.toThrow(
      'daemon incarnation changed during startup reconciliation'
    )
    expect(router.getSessionRouteState(sessionId)).toBe('owned')
    await router.sendSignal(sessionId, 'SIGTERM')
    expect(current.adapter.sendSignal).toHaveBeenCalledExactlyOnceWith(sessionId, 'SIGTERM')
  })

  it('rejects a conclusive-absence result when discovery becomes incomplete in flight', async () => {
    const sessionId = 'stale-absence-probe'
    const current = createAdapter('current')
    const legacy = createAdapter('legacy')
    let finishCurrentProbe: ((result: boolean) => void) | undefined
    let finishLegacyProbe: ((result: boolean) => void) | undefined
    vi.mocked(current.adapter.probePtyLiveness).mockReturnValue(
      new Promise((resolve) => {
        finishCurrentProbe = resolve
      })
    )
    vi.mocked(legacy.adapter.probePtyLiveness).mockReturnValue(
      new Promise((resolve) => {
        finishLegacyProbe = resolve
      })
    )
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })

    const signaling = router.sendSignal(sessionId, 'SIGTERM')
    await vi.waitFor(() => {
      expect(finishCurrentProbe).toBeDefined()
      expect(finishLegacyProbe).toBeDefined()
    })
    vi.mocked(legacy.adapter.listProcesses).mockRejectedValueOnce(new Error('listing unavailable'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await router.discoverLegacySessions()
    finishCurrentProbe?.(false)
    finishLegacyProbe?.(false)

    await expect(signaling).rejects.toThrow('daemon_session_routing_unavailable')
    expect(current.adapter.sendSignal).not.toHaveBeenCalled()
    expect(legacy.adapter.sendSignal).not.toHaveBeenCalled()
  })

  it('keeps a canonical spawn collision ambiguous', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', ['canonical-session'])
    vi.mocked(current.adapter.spawn).mockResolvedValue({
      id: 'canonical-session',
      incarnationId: 'current-incarnation'
    })
    vi.mocked(current.adapter.probePtyLiveness).mockResolvedValue(true)
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })
    await router.discoverLegacySessions()

    await router.spawn({
      sessionId: 'requested-session',
      isNewSession: true,
      cols: 80,
      rows: 24,
      agentSessionEnsure: {} as never
    })

    expect(router.getSessionRouteState('canonical-session')).toBe('ambiguous')
    await expect(router.sendSignal('canonical-session', 'SIGTERM')).rejects.toThrow(
      'daemon_session_routing_unavailable'
    )
    expect(current.adapter.sendSignal).not.toHaveBeenCalled()
    expect(legacy.adapter.sendSignal).not.toHaveBeenCalled()
  })

  it('keeps an existing id tombstoned when a replacement reports the same id', async () => {
    const sessionId = 'legacy-session'
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', [sessionId])
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })
    const previous = identity('legacy', 10)
    const replacement = identity('legacy', 11)

    await router.discoverLegacySessions()
    legacy.setIdentity(replacement)
    legacy.emitIdentityChange(previous, replacement)

    expect(router.getSessionRouteState(sessionId)).toBe('unavailable')
    await expect(router.sendSignal(sessionId, 'SIGTERM')).rejects.toThrow(
      'daemon_session_routing_unavailable'
    )
    expect(current.adapter.sendSignal).not.toHaveBeenCalled()

    await router.discoverLegacySessions()
    expect(router.getSessionRouteState(sessionId)).toBe('unavailable')
    await expect(router.sendSignal(sessionId, 'SIGTERM')).rejects.toThrow(
      'daemon_session_routing_unavailable'
    )
    expect(legacy.adapter.sendSignal).not.toHaveBeenCalled()
  })

  it('does not transfer an owned route from replacement discovery', async () => {
    const sessionId = 'replacement-discovery'
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', [sessionId])
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })

    await router.discoverLegacySessions()
    legacy.setIdentity(identity('legacy', 11))
    await router.discoverLegacySessions()

    expect(router.getSessionRouteState(sessionId)).toBe('unavailable')
    await expect(router.sendSignal(sessionId, 'SIGTERM')).rejects.toThrow(
      'daemon_session_routing_unavailable'
    )
    expect(legacy.adapter.sendSignal).not.toHaveBeenCalled()
  })

  it('allows explicit fresh reuse after the tombstone owner is replaced', async () => {
    const sessionId = 'legacy-session'
    const legacySessions = [sessionId]
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', legacySessions)
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })
    const previous = identity('legacy', 10)
    const replacement = identity('legacy', 11)

    await router.discoverLegacySessions()
    legacy.setIdentity(replacement)
    legacy.emitIdentityChange(previous, replacement)
    legacySessions.splice(0)
    await router.discoverLegacySessions()

    await expect(
      router.spawn({ sessionId, isNewSession: true, cols: 80, rows: 24 })
    ).resolves.toMatchObject({ id: sessionId })
    expect(current.adapter.spawn).toHaveBeenCalledExactlyOnceWith({
      sessionId,
      isNewSession: true,
      cols: 80,
      rows: 24
    })
  })

  it('acknowledges a colliding id through the adapter that produced its snapshot', async () => {
    const sessionId = 'colliding-snapshot'
    const current = createAdapter('current', [sessionId], {
      alive: [sessionId],
      killed: []
    })
    const legacy = createAdapter('legacy', [sessionId])
    vi.mocked(legacy.adapter.getBufferSnapshot).mockResolvedValue({
      data: 'legacy frame',
      cols: 80,
      rows: 24,
      seq: 1,
      source: 'headless'
    })
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })

    await router.discoverLegacySessions()
    await router.getBufferSnapshot(sessionId)
    await router.reconcileOnStartup(new Set())
    router.ackColdRestore(sessionId)

    expect(legacy.adapter.ackColdRestore).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(current.adapter.ackColdRestore).not.toHaveBeenCalled()
  })

  it('clears a stale snapshot producer after a later null capture', async () => {
    const sessionId = 'legacy-snapshot'
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', [sessionId])
    vi.mocked(legacy.adapter.getBufferSnapshot)
      .mockResolvedValueOnce({
        data: 'legacy frame',
        cols: 80,
        rows: 24,
        seq: 1,
        source: 'headless'
      })
      .mockResolvedValueOnce(null)
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })

    await router.discoverLegacySessions()
    await router.getBufferSnapshot(sessionId)
    await router.getBufferSnapshot(sessionId)
    router.ackColdRestore(sessionId)

    expect(legacy.adapter.ackColdRestore).not.toHaveBeenCalled()
  })

  it('keeps the newest snapshot producer when captures finish out of order', async () => {
    const sessionId = 'concurrent-snapshot'
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', [sessionId])
    let finishFirstCapture: ((snapshot: null) => void) | undefined
    vi.mocked(legacy.adapter.getBufferSnapshot)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirstCapture = resolve
          })
      )
      .mockResolvedValueOnce({
        data: 'newest frame',
        cols: 80,
        rows: 24,
        seq: 2,
        source: 'headless'
      })
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })

    await router.discoverLegacySessions()
    const firstCapture = router.getBufferSnapshot(sessionId)
    await vi.waitFor(() => expect(finishFirstCapture).toBeDefined())
    await router.getBufferSnapshot(sessionId)
    finishFirstCapture?.(null)
    await firstCapture
    router.ackColdRestore(sessionId)

    expect(legacy.adapter.ackColdRestore).toHaveBeenCalledExactlyOnceWith(sessionId)
  })

  it('does not acknowledge an old snapshot against a replacement daemon', async () => {
    const sessionId = 'replacement-snapshot'
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', [sessionId])
    vi.mocked(legacy.adapter.getBufferSnapshot).mockResolvedValue({
      data: 'legacy frame',
      cols: 80,
      rows: 24,
      seq: 1,
      source: 'headless'
    })
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })
    const previous = identity('legacy', 10)
    const replacement = identity('legacy', 11)

    await router.discoverLegacySessions()
    await router.getBufferSnapshot(sessionId)
    legacy.setIdentity(replacement)
    legacy.emitIdentityChange(previous, replacement)
    router.ackColdRestore(sessionId)

    expect(legacy.adapter.ackColdRestore).not.toHaveBeenCalled()
  })

  it('does not acknowledge a snapshot whose producer changes incarnation in flight', async () => {
    const sessionId = 'in-flight-replacement-snapshot'
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', [sessionId])
    let finishSnapshot:
      | ((snapshot: {
          data: string
          cols: number
          rows: number
          seq: number
          source: 'headless'
        }) => void)
      | undefined
    vi.mocked(legacy.adapter.getBufferSnapshot).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSnapshot = resolve
        })
    )
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })
    const previous = identity('legacy', 10)
    const replacement = identity('legacy', 11)

    await router.discoverLegacySessions()
    const capturing = router.getBufferSnapshot(sessionId)
    await vi.waitFor(() => expect(finishSnapshot).toBeDefined())
    legacy.setIdentity(replacement)
    legacy.emitIdentityChange(previous, replacement)
    finishSnapshot?.({
      data: 'legacy frame',
      cols: 80,
      rows: 24,
      seq: 1,
      source: 'headless'
    })
    await capturing
    router.ackColdRestore(sessionId)

    expect(legacy.adapter.ackColdRestore).not.toHaveBeenCalled()
  })

  it('drops pending snapshot acknowledgements only for the exiting producer', async () => {
    const sessionId = 'exiting-snapshot'
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', [sessionId])
    vi.mocked(legacy.adapter.getBufferSnapshot).mockResolvedValue({
      data: 'legacy frame',
      cols: 80,
      rows: 24,
      seq: 1,
      source: 'headless'
    })
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })

    await router.discoverLegacySessions()
    await router.getBufferSnapshot(sessionId)
    current.emitExit(sessionId, 0)
    router.ackColdRestore(sessionId)
    expect(legacy.adapter.ackColdRestore).toHaveBeenCalledExactlyOnceWith(sessionId)

    await router.getBufferSnapshot(sessionId)
    legacy.emitExit(sessionId, 0)
    router.ackColdRestore(sessionId)
    expect(legacy.adapter.ackColdRestore).toHaveBeenCalledOnce()
  })

  it('bounds unavailable route retention', async () => {
    const killed = Array.from({ length: 1001 }, (_, index) => `closed-${index}`)
    const currentSessions: string[] = []
    const current = createAdapter('current', currentSessions, { alive: [], killed })
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: []
    })
    const exit = vi.fn()
    router.onExit(exit)

    await router.reconcileOnStartup(new Set())

    expect(router.getSessionRouteState('closed-0')).toBeNull()
    expect(router.getSessionRouteState('closed-1')).toBe('unavailable')
    expect(router.getSessionRouteState('closed-1000')).toBe('unavailable')

    currentSessions.push('closed-0')
    await expect(router.sendSignal('closed-0', 'SIGTERM')).rejects.toThrow(
      'daemon_session_routing_unavailable'
    )
    expect(() => current.emitExit('closed-0', 0)).not.toThrow()
    expect(exit).not.toHaveBeenCalled()
    expect(current.adapter.sendSignal).not.toHaveBeenCalled()
  })

  it('passes folder and git-worktree keys through the same reconciliation path', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy')
    const router = new DaemonPtyRouter({
      current: current.adapter,
      legacy: [legacy.adapter]
    })
    const validWorkspaceKeys = new Set(['folder:folder-1', 'repo-1::/workspace/project'])

    await router.reconcileOnStartup(validWorkspaceKeys)

    expect(current.adapter.reconcileOnStartup).toHaveBeenCalledExactlyOnceWith(validWorkspaceKeys)
    expect(legacy.adapter.reconcileOnStartup).toHaveBeenCalledExactlyOnceWith(validWorkspaceKeys)
  })
})
