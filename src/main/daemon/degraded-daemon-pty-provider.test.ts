import { describe, expect, it, vi } from 'vitest'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import type { DaemonIdentityChangeEvent } from './daemon-pty-adapter'
import type { PtySpawnResult } from '../providers/types'
import { createDaemonAdapter, createProvider } from './degraded-daemon-pty-provider-fixture'

it('forwards dead-endpoint write-unavailable signals from exact daemon owners', async () => {
  // Why revert-sensitive: this provider is the live localProvider in degraded launch
  // mode and main subscribes on it, so without forwarding the STA-2373 fan-out reaches
  // no listener and sibling panes stay frozen.
  const current = createDaemonAdapter('daemon', ['daemon-pane'])
  const legacy = createDaemonAdapter('legacy', ['legacy-pane'])
  const fallback = createProvider('fallback')
  const provider = new DegradedDaemonPtyProvider({ current, legacy: [legacy], fallback })
  const recovered: string[] = []
  await provider.discoverDaemonSessions()

  const unsubscribe = provider.onWriteUnavailable(({ id }) => recovered.push(id))
  current.triggerWriteUnavailable('daemon-pane')
  legacy.triggerWriteUnavailable('legacy-pane')
  expect(recovered).toEqual(['daemon-pane', 'legacy-pane'])

  unsubscribe()
  current.triggerWriteUnavailable('after-unsubscribe')
  expect(recovered).toEqual(['daemon-pane', 'legacy-pane'])
})

it('withholds degraded write-unavailable signals from a foreign daemon route', async () => {
  const current = createDaemonAdapter('daemon', ['shared-pane'])
  const legacy = createDaemonAdapter('legacy')
  const fallback = createProvider('fallback')
  const provider = new DegradedDaemonPtyProvider({ current, legacy: [legacy], fallback })
  const recovered: string[] = []
  await provider.discoverDaemonSessions()
  provider.onWriteUnavailable(({ id }) => recovered.push(id))

  legacy.triggerWriteUnavailable('shared-pane')
  current.triggerWriteUnavailable('shared-pane')

  expect(recovered).toEqual(['shared-pane'])
})

it('withholds degraded write-unavailable signals for fallback collisions', async () => {
  const sessionId = 'fallback-collision'
  const current = createDaemonAdapter('daemon', [sessionId])
  const fallback = createProvider('fallback')
  const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })
  await provider.spawn({ sessionId, isNewSession: true, cols: 80, rows: 24 })
  await provider.discoverDaemonSessions()
  const recovered: string[] = []
  provider.onWriteUnavailable(({ id }) => recovered.push(id))

  current.triggerWriteUnavailable(sessionId)

  expect(recovered).toEqual([])
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

  it('fences existing ids after incomplete daemon discovery while allowing explicit fresh ids', async () => {
    const sessionId = 'uncertain-session'
    const current = createDaemonAdapter('daemon')
    const legacy = createDaemonAdapter('legacy')
    const fallback = createProvider('fallback')
    vi.mocked(legacy.listProcesses).mockRejectedValueOnce(new Error('listing unavailable'))
    vi.mocked(legacy.probePtyLiveness).mockResolvedValue(null)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [legacy], fallback })

    await provider.discoverDaemonSessions()

    await expect(provider.spawn({ sessionId, cols: 80, rows: 24 })).rejects.toThrow(
      'daemon_session_routing_unavailable'
    )
    await expect(
      provider.spawn({ sessionId: 'fresh-session', isNewSession: true, cols: 80, rows: 24 })
    ).resolves.toMatchObject({ id: 'fresh-session' })
    expect(fallback.spawn).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'fresh-session',
      isNewSession: true,
      cols: 80,
      rows: 24
    })
    warn.mockRestore()
  })

  it('keeps cross-generation daemon collisions away from the fallback', async () => {
    const sessionId = 'daemon-collision'
    const current = createDaemonAdapter('current', [sessionId])
    const legacy = createDaemonAdapter('legacy', [sessionId])
    const fallback = createProvider('fallback')
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [legacy], fallback })
    const data = vi.fn()
    provider.onData(data)

    await provider.discoverDaemonSessions()
    current.emitData(sessionId, 'current output')
    legacy.emitData(sessionId, 'legacy output')

    await expect(provider.spawn({ sessionId, cols: 80, rows: 24 })).rejects.toThrow(
      'daemon_session_routing_unavailable'
    )
    expect(() => provider.pauseProducer(sessionId)).not.toThrow()
    expect(() => provider.resumeProducer(sessionId)).not.toThrow()
    expect(() => provider.setPtyBackgrounded(sessionId, true)).not.toThrow()
    expect(data).not.toHaveBeenCalled()
    expect(fallback.spawn).not.toHaveBeenCalled()
    expect(fallback.pauseProducer).not.toHaveBeenCalled()
    expect(fallback.resumeProducer).not.toHaveBeenCalled()
    expect(fallback.setPtyBackgrounded).not.toHaveBeenCalled()
  })

  it('tombstones a previously daemon-backed id after its daemon exits', async () => {
    const current = createDaemonAdapter('daemon', ['daemon-session'])
    const fallback = createProvider('fallback')
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })

    await provider.discoverDaemonSessions()
    current.emitExit('daemon-session', 0)
    await expect(
      provider.spawn({ sessionId: 'daemon-session', cols: 80, rows: 24 })
    ).rejects.toThrow('daemon_session_routing_unavailable')

    expect(fallback.spawn).not.toHaveBeenCalled()
  })

  it('caches a provider discovered by hasPty before routing later operations', () => {
    const current = createDaemonAdapter('daemon', ['daemon-session'])
    const fallback = createProvider('fallback')
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })

    expect(provider.hasPty('daemon-session')).toBe(true)
    provider.write('daemon-session', 'kept-on-daemon\n')

    expect(current.write).toHaveBeenCalledWith('daemon-session', 'kept-on-daemon\n')
    expect(fallback.write).not.toHaveBeenCalled()
    expect(current.hasPty).toHaveBeenCalledExactlyOnceWith('daemon-session')
  })

  it('probes each daemon once before memoizing a unique owner', () => {
    const current = createDaemonAdapter('current')
    const legacy = createDaemonAdapter('legacy', ['legacy-session'])
    const fallback = createProvider('fallback')
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [legacy], fallback })

    provider.write('legacy-session', 'first\n')
    provider.resize('legacy-session', 100, 30)

    expect(current.hasPty).toHaveBeenCalledExactlyOnceWith('legacy-session')
    expect(legacy.hasPty).toHaveBeenCalledExactlyOnceWith('legacy-session')
    expect(legacy.write).toHaveBeenCalledExactlyOnceWith('legacy-session', 'first\n')
    expect(legacy.resize).toHaveBeenCalledExactlyOnceWith('legacy-session', 100, 30)
    expect(fallback.hasPty).not.toHaveBeenCalled()
  })

  it('probes daemon owners without borrowing fallback liveness', async () => {
    const current = createDaemonAdapter('current')
    const legacy = createDaemonAdapter('legacy')
    const fallback = createProvider('fallback', ['unknown-session'])
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [legacy], fallback })
    vi.mocked(legacy.probePtyLiveness).mockResolvedValue(null)

    await expect(provider.probePtyLiveness('unknown-session')).resolves.toBeNull()
    expect(fallback.probePtyLiveness).not.toHaveBeenCalled()

    vi.mocked(current.probePtyLiveness).mockResolvedValue(true)
    await expect(provider.probePtyLiveness('unknown-session')).resolves.toBeNull()

    vi.mocked(legacy.probePtyLiveness).mockResolvedValue(false)
    await expect(provider.probePtyLiveness('unknown-session')).resolves.toBe(true)
  })

  it('keeps fallback liveness unknown when daemon ownership appears during the probe', async () => {
    const sessionId = 'fallback-probe-collision'
    const current = createDaemonAdapter('current')
    const fallback = createProvider('fallback')
    let settleProbe!: (result: boolean | null) => void
    fallback.probePtyLiveness = vi.fn(
      () => new Promise<boolean | null>((resolve) => (settleProbe = resolve))
    )
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })
    await provider.spawn({ sessionId, isNewSession: true, cols: 80, rows: 24 })

    const liveness = provider.probePtyLiveness(sessionId)
    current.emitData(sessionId, 'colliding daemon output')
    settleProbe(false)

    await expect(liveness).resolves.toBeNull()
  })

  it('discards fallback liveness after same-provider reuse of the session id', async () => {
    const sessionId = 'reused-fallback-probe'
    const current = createDaemonAdapter('current')
    const fallback = createProvider('fallback')
    let settleProbe!: (result: boolean | null) => void
    fallback.probePtyLiveness = vi.fn(
      () => new Promise<boolean | null>((resolve) => (settleProbe = resolve))
    )
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })
    await provider.spawn({ sessionId, isNewSession: true, cols: 80, rows: 24 })

    const staleLiveness = provider.probePtyLiveness(sessionId)
    fallback.emitExit(sessionId, 0)
    await provider.spawn({ sessionId, isNewSession: true, cols: 80, rows: 24 })
    settleProbe(false)

    await expect(staleLiveness).resolves.toBeNull()
    provider.write(sessionId, 'replacement survives')
    expect(fallback.write).toHaveBeenCalledExactlyOnceWith(sessionId, 'replacement survives')
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

  it('keeps colliding liveness unknown and acknowledges through the snapshot producer', async () => {
    const sessionId = 'colliding-session'
    const current = createDaemonAdapter('current')
    const legacy = createDaemonAdapter('legacy', [sessionId])
    const fallback = createProvider('fallback')
    legacy.getBufferSnapshot = vi.fn(async () => ({
      data: 'legacy frame',
      cols: 80,
      rows: 24,
      seq: 1,
      source: 'headless' as const
    }))
    const provider = new DegradedDaemonPtyProvider({
      current,
      legacy: [legacy],
      fallback
    })

    await provider.discoverDaemonSessions()
    await provider.getBufferSnapshot(sessionId)
    current.emitData(sessionId, 'colliding current output')
    expect(() => provider.hasPty(sessionId)).toThrow('daemon_session_routing_unavailable')
    provider.ackColdRestore(sessionId)

    expect(legacy.ackColdRestore).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(current.ackColdRestore).not.toHaveBeenCalled()
  })

  it('forwards replay output from owned fallback and daemon providers', async () => {
    const current = createDaemonAdapter('daemon')
    const fallback = createProvider('fallback')
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })
    const replaySpy = vi.fn()

    const unsubscribe = provider.onReplay(replaySpy)
    await provider.spawn({
      sessionId: 'fallback-session',
      isNewSession: true,
      cols: 80,
      rows: 24
    })
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

  it('withholds replay output when daemon and fallback ids collide', async () => {
    const sessionId = 'replay-collision'
    const current = createDaemonAdapter('daemon')
    const fallback = createProvider('fallback')
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })
    const replay = vi.fn()
    provider.onReplay(replay)
    await provider.spawn({ sessionId, isNewSession: true, cols: 80, rows: 24 })

    current.emitReplay(sessionId, 'daemon replay')
    fallback.emitReplay(sessionId, 'fallback replay')

    expect(replay).not.toHaveBeenCalled()
  })

  it('keeps a daemon survivor live when a colliding fallback exits first', async () => {
    const sessionId = 'fallback-exits-first'
    const current = createDaemonAdapter('daemon')
    const fallback = createProvider('fallback')
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })
    const data = vi.fn()
    const exit = vi.fn()
    provider.onData(data)
    provider.onExit(exit)
    await provider.spawn({ sessionId, isNewSession: true, cols: 80, rows: 24 })

    current.emitData(sessionId, 'withheld collision')
    fallback.emitExit(sessionId, 0)
    current.emitData(sessionId, 'daemon survivor')

    expect(exit).not.toHaveBeenCalled()
    expect(data).toHaveBeenCalledExactlyOnceWith({
      id: sessionId,
      data: 'daemon survivor'
    })
  })

  it('keeps a fallback survivor live when a colliding daemon exits first', async () => {
    const sessionId = 'daemon-exits-first'
    const current = createDaemonAdapter('daemon')
    const fallback = createProvider('fallback')
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })
    const data = vi.fn()
    const exit = vi.fn()
    provider.onData(data)
    provider.onExit(exit)
    await provider.spawn({ sessionId, isNewSession: true, cols: 80, rows: 24 })

    current.emitData(sessionId, 'withheld collision')
    current.emitExit(sessionId, 0)
    fallback.emitData(sessionId, 'fallback survivor')
    fallback.emitExit(sessionId, 0)

    expect(data).toHaveBeenCalledExactlyOnceWith({
      id: sessionId,
      data: 'fallback survivor'
    })
    expect(exit).toHaveBeenCalledExactlyOnceWith({ id: sessionId, code: 0 })
  })

  it('releases a fallback survivor when the colliding daemon changes incarnation', async () => {
    const sessionId = 'daemon-incarnation-collision'
    const previous = { pid: 1, startedAtMs: 1, launchNonce: 'previous' }
    const currentIdentity = { pid: 2, startedAtMs: 2, launchNonce: 'current' }
    const current = createDaemonAdapter('daemon')
    const fallback = createProvider('fallback')
    let identity = previous
    let notifyIdentityChange!: (event: DaemonIdentityChangeEvent) => void
    vi.mocked(current.getLastAuthenticatedDaemonIdentity).mockImplementation(() => identity)
    vi.mocked(current.onDaemonIdentityChanged).mockImplementation((listener) => {
      notifyIdentityChange = listener
      return () => {}
    })
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })
    const data = vi.fn()
    provider.onData(data)
    await provider.spawn({ sessionId, isNewSession: true, cols: 80, rows: 24 })

    current.emitData(sessionId, 'withheld collision')
    expect(() => provider.write(sessionId, 'withheld write')).toThrow(
      'daemon_session_routing_unavailable'
    )
    identity = currentIdentity
    notifyIdentityChange({ previous, current: currentIdentity })
    fallback.emitData(sessionId, 'fallback survivor')
    provider.write(sessionId, 'surviving write')

    expect(data).toHaveBeenCalledExactlyOnceWith({
      id: sessionId,
      data: 'fallback survivor'
    })
    expect(fallback.write).toHaveBeenCalledExactlyOnceWith(sessionId, 'surviving write')
  })

  it('keeps a fallback collision fenced while another daemon owner survives', async () => {
    const sessionId = 'two-daemon-fallback-collision'
    const current = createDaemonAdapter('current')
    const legacy = createDaemonAdapter('legacy')
    const fallback = createProvider('fallback')
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [legacy], fallback })
    const data = vi.fn()
    provider.onData(data)
    await provider.spawn({ sessionId, isNewSession: true, cols: 80, rows: 24 })

    current.emitData(sessionId, 'current collision')
    legacy.emitData(sessionId, 'legacy collision')
    current.emitExit(sessionId, 0)
    fallback.emitData(sessionId, 'still colliding')

    expect(() => provider.write(sessionId, 'blocked')).toThrow('daemon_session_routing_unavailable')
    expect(data).not.toHaveBeenCalled()

    legacy.emitExit(sessionId, 0)
    fallback.emitData(sessionId, 'fallback survivor')
    provider.write(sessionId, 'allowed')

    expect(data).toHaveBeenCalledExactlyOnceWith({
      id: sessionId,
      data: 'fallback survivor'
    })
    expect(fallback.write).toHaveBeenCalledExactlyOnceWith(sessionId, 'allowed')
  })

  it('fences foreign events before a fresh fallback reply and keeps the fallback routable', async () => {
    const sessionId = 'in-flight-fallback-spawn'
    const current = createDaemonAdapter('daemon')
    const fallback = createProvider('fallback')
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })
    const data = vi.fn()
    const exit = vi.fn()
    provider.onData(data)
    provider.onExit(exit)
    let resolveSpawn!: (result: PtySpawnResult) => void
    vi.mocked(fallback.spawn).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSpawn = resolve
      })
    )

    const spawning = provider.spawn({ sessionId, isNewSession: true, cols: 80, rows: 24 })
    current.emitData(sessionId, 'foreign daemon output')
    current.emitExit(sessionId, 0)
    fallback.emitData(sessionId, 'fallback first')
    resolveSpawn({ id: sessionId })
    await spawning
    provider.write(sessionId, 'fallback input')

    expect(data).toHaveBeenCalledExactlyOnceWith({
      id: sessionId,
      data: 'fallback first'
    })
    expect(exit).not.toHaveBeenCalled()
    expect(fallback.write).toHaveBeenCalledExactlyOnceWith(sessionId, 'fallback input')
    expect(current.write).not.toHaveBeenCalled()
  })

  it('keeps an in-flight fallback fenced across identity changes until confirmation', async () => {
    const sessionId = 'in-flight-incarnation-collision'
    const previous = { pid: 1, startedAtMs: 1, launchNonce: 'previous' }
    const replacement = { pid: 2, startedAtMs: 2, launchNonce: 'replacement' }
    const current = createDaemonAdapter('daemon')
    const fallback = createProvider('fallback')
    let identity = previous
    let notifyIdentityChange!: (event: DaemonIdentityChangeEvent) => void
    vi.mocked(current.getLastAuthenticatedDaemonIdentity).mockImplementation(() => identity)
    vi.mocked(current.onDaemonIdentityChanged).mockImplementation((listener) => {
      notifyIdentityChange = listener
      return () => {}
    })
    let resolveSpawn!: (result: PtySpawnResult) => void
    vi.mocked(fallback.spawn).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSpawn = resolve
      })
    )
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })
    const data = vi.fn()
    provider.onData(data)

    const spawning = provider.spawn({ sessionId, isNewSession: true, cols: 80, rows: 24 })
    current.emitData(sessionId, 'foreign daemon output')
    identity = replacement
    notifyIdentityChange({ previous, current: replacement })
    fallback.emitData(sessionId, 'still fenced')

    expect(data).not.toHaveBeenCalled()
    expect(() => provider.write(sessionId, 'blocked input')).toThrow(
      'daemon_session_routing_unavailable'
    )

    resolveSpawn({ id: sessionId })
    await spawning
    fallback.emitData(sessionId, 'fallback after confirmation')
    provider.write(sessionId, 'fallback input')

    expect(data).toHaveBeenCalledExactlyOnceWith({
      id: sessionId,
      data: 'fallback after confirmation'
    })
    expect(fallback.write).toHaveBeenCalledExactlyOnceWith(sessionId, 'fallback input')
  })

  it('drops an unconfirmed collision when fallback spawn fails', async () => {
    const sessionId = 'rejected-fallback-collision'
    const current = createDaemonAdapter('daemon')
    const fallback = createProvider('fallback')
    let rejectSpawn!: (error: Error) => void
    vi.mocked(fallback.spawn).mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectSpawn = reject
      })
    )
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })

    const spawning = provider.spawn({ sessionId, isNewSession: true, cols: 80, rows: 24 })
    current.emitData(sessionId, 'foreign daemon output')
    rejectSpawn(new Error('spawn failed'))

    await expect(spawning).rejects.toThrow('spawn failed')
    expect(provider.hasPty(sessionId)).toBe(false)
  })

  it('rejects unknown fallback output after unavailable tombstones are evicted', async () => {
    const current = createDaemonAdapter('daemon')
    const fallback = createProvider('fallback')
    const previous = { pid: 1, startedAtMs: 1, launchNonce: 'previous' }
    const replacement = { pid: 2, startedAtMs: 2, launchNonce: 'replacement' }
    let identity = previous
    let notifyIdentityChange!: (event: DaemonIdentityChangeEvent) => void
    vi.mocked(current.getLastAuthenticatedDaemonIdentity).mockImplementation(() => identity)
    vi.mocked(current.onDaemonIdentityChanged).mockImplementation((listener) => {
      notifyIdentityChange = listener
      return () => {}
    })
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })

    for (let index = 0; index <= 1_000; index += 1) {
      const sessionId = `evicted-${index}`
      current.emitData(sessionId, 'frame')
      current.emitExit(sessionId, 0)
    }

    const data = vi.fn()
    provider.onData(data)
    fallback.emitData('unknown-fallback', 'unsafe frame')

    expect(data).not.toHaveBeenCalled()
    expect(() => provider.write('unknown-fallback', 'unsafe input')).toThrow(
      'daemon_session_routing_unavailable'
    )

    vi.mocked(fallback.spawn).mockImplementationOnce(async () => {
      fallback.emitData('explicit-fallback', 'safe frame')
      return { id: 'explicit-fallback' }
    })
    await provider.spawn({
      sessionId: 'explicit-fallback',
      isNewSession: true,
      cols: 80,
      rows: 24
    })

    expect(data).toHaveBeenCalledExactlyOnceWith({
      id: 'explicit-fallback',
      data: 'safe frame'
    })

    current.emitData('explicit-fallback', 'foreign frame')
    identity = replacement
    notifyIdentityChange({ previous, current: replacement })
    fallback.emitData('explicit-fallback', 'surviving frame')
    provider.write('explicit-fallback', 'safe input')

    expect(data).toHaveBeenNthCalledWith(2, {
      id: 'explicit-fallback',
      data: 'surviving frame'
    })
    expect(fallback.write).toHaveBeenCalledExactlyOnceWith('explicit-fallback', 'safe input')
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
    const stuck = await provider.spawn({
      sessionId: 'stuck',
      isNewSession: true,
      cols: 80,
      rows: 24
    })
    await provider.spawn({ sessionId: 'ok', isNewSession: true, cols: 80, rows: 24 })
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

  it('reconciles live owners before same-id tombstones regardless of adapter order', async () => {
    const sessionId = 'reconciled-owner'
    const current = createDaemonAdapter('current')
    const legacy = createDaemonAdapter('legacy', [sessionId])
    const fallback = createProvider('fallback')
    vi.mocked(current.reconcileOnStartup).mockResolvedValue({
      alive: [],
      killed: [sessionId]
    })
    vi.mocked(legacy.reconcileOnStartup).mockResolvedValue({
      alive: [sessionId],
      killed: []
    })
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [legacy], fallback })

    await provider.reconcileOnStartup(new Set())
    await provider.sendSignal(sessionId, 'SIGTERM')

    expect(legacy.sendSignal).toHaveBeenCalledExactlyOnceWith(sessionId, 'SIGTERM')
    expect(current.sendSignal).not.toHaveBeenCalled()
    expect(fallback.sendSignal).not.toHaveBeenCalled()
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
    expect(fallback.listProcesses).toHaveBeenCalledTimes(2)
  })
})
