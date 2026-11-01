import { createAdapter } from './daemon-pty-router-test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { DaemonPtyRouter } from './daemon-pty-router'
import { SessionNotFoundError, TerminalSessionOwnerUnverifiedError } from './daemon-errors'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { PtyProcessInfo, PtySpawnResult } from '../providers/pty-provider-contract'
import { HISTORY_SEED_TRANSFER_PROTOCOL_VERSION, PROTOCOL_VERSION } from './daemon-protocol-version'

const LARGE_RECONCILE_SESSION_COUNT = 150_000

function buildSessionIds(prefix: string, count: number): string[] {
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    ids.push(`${prefix}-${index}`)
  }
  return ids
}

describe('DaemonPtyRouter', () => {
  describe('idle retirement', () => {
    it('retires every empty daemon generation and fences subsequent spawns', async () => {
      const current = createAdapter('current', [], undefined, PROTOCOL_VERSION)
      const legacy = createAdapter('legacy', [], undefined, PROTOCOL_VERSION)
      const router = new DaemonPtyRouter({ current, legacy: [legacy] })

      await expect(router.requestIdleRetirement()).resolves.toEqual({ state: 'retiring' })
      expect(current.requestIdleRetirement).toHaveBeenCalledOnce()
      expect(legacy.requestIdleRetirement).toHaveBeenCalledOnce()
      await expect(router.spawn({ sessionId: 'late', cols: 80, rows: 24 })).rejects.toThrow(
        'Terminal daemon is decommissioning'
      )
    })

    it('reports live inventory before retiring any generation and reopens admission', async () => {
      const current = createAdapter('current', [], undefined, PROTOCOL_VERSION)
      const legacy = createAdapter('legacy', ['legacy-live'], undefined, PROTOCOL_VERSION)
      const router = new DaemonPtyRouter({ current, legacy: [legacy] })

      await expect(router.requestIdleRetirement()).resolves.toEqual({
        state: 'busy',
        liveSessions: 1,
        admissionReopened: true
      })
      expect(current.requestIdleRetirement).not.toHaveBeenCalled()
      expect(legacy.requestIdleRetirement).not.toHaveBeenCalled()
      await expect(
        router.spawn({ sessionId: 'after-refusal', cols: 80, rows: 24 })
      ).resolves.toEqual({
        id: 'after-refusal'
      })
    })

    it('does not certify reopened admission when another generation retired beside live sessions', async () => {
      const current = createAdapter('current', [], undefined, PROTOCOL_VERSION)
      const legacy = createAdapter('legacy', [], undefined, PROTOCOL_VERSION)
      vi.mocked(legacy.requestIdleRetirement).mockResolvedValueOnce({
        state: 'busy',
        liveSessions: 1,
        admissionReopened: true
      })
      const router = new DaemonPtyRouter({ current, legacy: [legacy] })
      await expect(router.requestIdleRetirement()).resolves.toEqual({
        state: 'busy',
        liveSessions: 1
      })
      await expect(
        router.spawn({ sessionId: 'unsafe-partial', cols: 80, rows: 24 })
      ).rejects.toThrow('Terminal daemon is decommissioning')
    })
  })

  it.each([false, true])(
    'keeps newer spawn authority when an older listing completes (duplicate ids: %s)',
    async (duplicateIds) => {
      const current = createAdapter('current')
      const legacy = createAdapter('legacy')
      current.supportsFencedTermination = () => true
      current.killFenced = vi.fn(async () => ({ outcome: 'ended' as const }))
      legacy.supportsFencedTermination = () => false
      legacy.killFenced = vi.fn(async () => ({
        outcome: 'refused' as const,
        reason: 'unsupported' as const
      }))
      vi.mocked(current.spawn).mockResolvedValue({ id: 'raced', incarnationId: 'new' })
      vi.mocked(current.listProcesses).mockResolvedValue(
        duplicateIds ? [{ id: 'raced', incarnationId: 'old-current', cwd: '', title: '' }] : []
      )
      const { promise: oldInventory, resolve: release } = Promise.withResolvers<PtyProcessInfo[]>()
      vi.mocked(legacy.listProcesses).mockReturnValue(oldInventory)
      const router = new DaemonPtyRouter({ current, legacy: [legacy] })
      const oldListing = router.listProcesses()
      expect(legacy.listProcesses).toHaveBeenCalledOnce()
      await router.spawn({ sessionId: 'raced', isNewSession: true, cols: 80, rows: 24 })
      release([{ id: 'raced', incarnationId: 'old-legacy', cwd: '', title: '' }])
      await expect(oldListing).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
      const request = {
        id: 'raced',
        expectedIncarnationId: 'new',
        requireNoAgentOwner: true,
        requireUnattached: true
      }

      expect(router.supportsFencedTermination('raced')).toBe(true)
      await expect(router.killFenced(request)).resolves.toEqual({ outcome: 'ended' })
      expect(current.killFenced).toHaveBeenCalledExactlyOnceWith(request)
      expect(legacy.killFenced).not.toHaveBeenCalled()
      expect(current.listProcesses).toHaveBeenCalledOnce()
      expect(legacy.listProcesses).toHaveBeenCalledOnce()
    }
  )

  it('does not let an older refresh overwrite a newer discovery route', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy')
    current.supportsFencedTermination = () => true
    current.killFenced = vi.fn(async () => ({ outcome: 'ended' as const }))
    legacy.supportsFencedTermination = () => false
    const { promise: staleCurrent, resolve: releaseCurrent } =
      Promise.withResolvers<PtyProcessInfo[]>()
    const { promise: staleLegacy, resolve: releaseLegacy } =
      Promise.withResolvers<PtyProcessInfo[]>()
    vi.mocked(current.listProcesses)
      .mockReturnValueOnce(staleCurrent)
      .mockResolvedValueOnce([{ id: 'discovered', incarnationId: 'new', cwd: '', title: '' }])
    vi.mocked(legacy.listProcesses).mockReturnValueOnce(staleLegacy).mockResolvedValueOnce([])
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    const staleRefresh = router.listProcesses()
    await router.discoverLegacySessions()
    releaseCurrent([])
    releaseLegacy([{ id: 'discovered', incarnationId: 'old', cwd: '', title: '' }])
    await expect(staleRefresh).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
    const request = {
      id: 'discovered',
      expectedIncarnationId: 'new',
      requireNoAgentOwner: true,
      requireUnattached: true
    }

    expect(router.supportsFencedTermination('discovered')).toBe(true)
    await expect(router.killFenced(request)).resolves.toEqual({ outcome: 'ended' })
    expect(current.killFenced).toHaveBeenCalledExactlyOnceWith(request)
    expect(current.listProcesses).toHaveBeenCalledTimes(2)
    expect(legacy.listProcesses).toHaveBeenCalledTimes(2)
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
    await vi.waitFor(() => expect(finishSpawn).toBeDefined())
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
    await vi.waitFor(() => expect(finishSpawn).toBeDefined())
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
    await vi.waitFor(() => expect(finishSpawn).toBeDefined())
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

  it('drops a legacy mapping after the routed session exits', async () => {
    const current = createAdapter('current')
    const legacySessions = ['legacy-session']
    const legacy = createAdapter('legacy', legacySessions)
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })

    await router.discoverLegacySessions()

    legacySessions.length = 0
    legacy.emitExit('legacy-session', 0)
    await router.spawn({ sessionId: 'legacy-session', cols: 80, rows: 24 })

    expect(current.spawn).toHaveBeenCalledWith({ sessionId: 'legacy-session', cols: 80, rows: 24 })
  })

  it('does not report absence while any possible daemon owner is unavailable', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy')
    vi.mocked(legacy.listProcesses).mockRejectedValue(new Error('legacy inventory unavailable'))
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })

    await expect(router.probePtyLiveness('unknown-session')).resolves.toBeNull()
  })

  it('routes an attach to a legacy session created after startup inventory', async () => {
    const current = createAdapter('current')
    const legacySessions = ['legacy-at-startup']
    const legacy = createAdapter('legacy', legacySessions)
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()
    legacySessions.push('legacy-created-later')

    await router.spawn({
      sessionId: 'legacy-created-later',
      attachOnly: true,
      cols: 80,
      rows: 24
    })

    expect(legacy.spawn).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'legacy-created-later',
      attachOnly: true,
      cols: 80,
      rows: 24
    })
    expect(current.spawn).not.toHaveBeenCalled()
  })

  it('keeps an attach unresolved when any possible owner inventory fails', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy')
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    vi.mocked(legacy.listProcesses).mockRejectedValue(new Error('wedged'))

    await expect(
      router.spawn({ sessionId: 'unknown-session', attachOnly: true, cols: 80, rows: 24 })
    ).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
    expect(current.spawn).not.toHaveBeenCalled()
    expect(legacy.spawn).not.toHaveBeenCalled()
  })

  it('re-resolves a stale positive route before declaring an owner absent', async () => {
    const current = createAdapter('current')
    const firstSessions = ['moved-session']
    const secondSessions: string[] = []
    const first = createAdapter('first', firstSessions)
    const second = createAdapter('second', secondSessions)
    const router = new DaemonPtyRouter({ current, legacy: [first, second] })
    await router.discoverLegacySessions()
    firstSessions.length = 0
    secondSessions.push('moved-session')
    vi.mocked(first.spawn).mockRejectedValueOnce(new SessionNotFoundError('moved-session'))

    await router.spawn({ sessionId: 'moved-session', attachOnly: true, cols: 80, rows: 24 })

    expect(first.spawn).toHaveBeenCalledOnce()
    expect(second.spawn).toHaveBeenCalledOnce()
  })

  it('invalidates positive routes when a daemon endpoint identity changes', async () => {
    const currentSessions: string[] = []
    const legacySessions = ['moved-session']
    const current = createAdapter('current', currentSessions)
    const legacy = createAdapter('legacy', legacySessions)
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()
    legacySessions.length = 0
    currentSessions.push('moved-session')

    legacy.emitIdentityChange()
    await router.spawn({ sessionId: 'moved-session', attachOnly: true, cols: 80, rows: 24 })

    expect(current.spawn).toHaveBeenCalledOnce()
    expect(legacy.spawn).not.toHaveBeenCalled()
  })

  it('hands a checkpointed pre-v30 session to the current daemon on wake', async () => {
    const current = createAdapter('current', [], undefined, HISTORY_SEED_TRANSFER_PROTOCOL_VERSION)
    const legacy = createAdapter(
      'legacy',
      ['legacy-session'],
      undefined,
      HISTORY_SEED_TRANSFER_PROTOCOL_VERSION - 1
    )
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()

    await router.shutdown('legacy-session', { keepHistory: true })
    await router.spawn({ sessionId: 'legacy-session', cols: 80, rows: 24 })

    expect(legacy.shutdown).toHaveBeenCalledWith('legacy-session', { keepHistory: true })
    expect(legacy.ackColdRestore).toHaveBeenCalledWith('legacy-session')
    expect(current.spawn).toHaveBeenCalledWith({
      sessionId: 'legacy-session',
      cols: 80,
      rows: 24
    })
    expect(legacy.spawn).not.toHaveBeenCalled()
  })

  it('keeps the legacy route when checkpointed shutdown fails', async () => {
    const current = createAdapter('current', [], undefined, HISTORY_SEED_TRANSFER_PROTOCOL_VERSION)
    const legacy = createAdapter(
      'legacy',
      ['legacy-session'],
      undefined,
      HISTORY_SEED_TRANSFER_PROTOCOL_VERSION - 1
    )
    vi.mocked(legacy.shutdown).mockRejectedValueOnce(new Error('checkpoint failed'))
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()

    await expect(router.shutdown('legacy-session', { keepHistory: true })).rejects.toThrow(
      'checkpoint failed'
    )
    await router.spawn({ sessionId: 'legacy-session', cols: 80, rows: 24 })

    expect(legacy.spawn).toHaveBeenCalled()
    expect(legacy.ackColdRestore).not.toHaveBeenCalled()
    expect(current.spawn).not.toHaveBeenCalled()
  })

  it('keeps a legacy adapter that exits after construction in fail-closed aggregates', async () => {
    const current = createAdapter('current', ['current-session'])
    const legacy = createAdapter('legacy', ['legacy-session'])
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()
    vi.mocked(legacy.listProcesses).mockRejectedValue(new Error('legacy exited'))

    await expect(router.listProcesses()).rejects.toThrow('legacy exited')
    await expect(router.listProcesses()).rejects.toThrow('legacy exited')
    expect(router.getLegacyAdapters()).toEqual([legacy])
    expect(current.listProcesses).toHaveBeenCalledTimes(3)
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

  // Restart reuses legacy adapters, so detach the old router without tearing them down.
  describe('disposeRouterOnly', () => {
    it('stops forwarding adapter onData/onExit to subscribers registered before dispose', () => {
      const current = createAdapter('current')
      const legacy = createAdapter('legacy')
      const router = new DaemonPtyRouter({ current, legacy: [legacy] })

      // Subscribe before disposal to exercise removal of existing adapter subscriptions.
      const dataSpy = vi.fn()
      const exitSpy = vi.fn()
      router.onData(dataSpy)
      router.onExit(exitSpy)

      router.disposeRouterOnly()

      current.emitData('current-id', 'hello')
      current.emitExit('current-id', 0)
      legacy.emitData('legacy-id', 'world')
      legacy.emitExit('legacy-id', 1)

      expect(dataSpy).not.toHaveBeenCalled()
      expect(exitSpy).not.toHaveBeenCalled()
    })
  })
})
