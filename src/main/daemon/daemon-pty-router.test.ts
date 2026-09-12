import { createAdapter } from './daemon-pty-router-test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { DaemonPtyRouter } from './daemon-pty-router'
import { stubWriteSettlement } from '../providers/settled-pty-write-stub'
import { SessionNotFoundError, TerminalSessionOwnerUnverifiedError } from './daemon-errors'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { PtySpawnResult } from '../providers/types'
import {
  AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION,
  AGENT_SESSION_CREATE_OPERATION_DAEMON_PROTOCOL_VERSION
} from './types'
import {
  HISTORY_SEED_TRANSFER_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION
} from './daemon-protocol-version'

const LARGE_RECONCILE_SESSION_COUNT = 150_000

function buildSessionIds(prefix: string, count: number): string[] {
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    ids.push(`${prefix}-${index}`)
  }
  return ids
}

it('forwards dead-endpoint write-unavailable signals from every routed adapter', () => {
  // Why revert-sensitive: main subscribes on the ROUTED provider, so if the router
  // does not forward this the STA-2373 fan-out never reaches the renderer and only
  // the written pane recovers — siblings stay frozen. The router is the live
  // localProvider whenever a legacy daemon socket exists (protocol bump mid-session).
  const current = createAdapter('current')
  const legacy = createAdapter('legacy')
  const router = new DaemonPtyRouter({ current, legacy: [legacy] })
  const recovered: string[] = []

  const unsubscribe = router.onWriteUnavailable(({ id }) => recovered.push(id))
  current.triggerWriteUnavailable('current-pane')
  legacy.triggerWriteUnavailable('legacy-pane')

  expect(recovered).toEqual(['current-pane', 'legacy-pane'])

  unsubscribe()
  current.triggerWriteUnavailable('after-unsubscribe')
  legacy.triggerWriteUnavailable('after-unsubscribe')
  expect(recovered).toEqual(['current-pane', 'legacy-pane'])
})

it('rejects completion inspection when no daemon owns the session', async () => {
  const router = new DaemonPtyRouter({
    current: createAdapter('current'),
    legacy: [createAdapter('legacy')]
  })

  await expect(router.inspectProcess('unmapped-session')).rejects.toThrow('terminal_gone')
})

it('preserves client-only unverifiable inspection from the owning legacy daemon', async () => {
  const legacy = createAdapter('legacy', ['legacy-session'])
  vi.mocked(legacy.inspectProcess).mockResolvedValue({
    foregroundProcess: null,
    hasChildProcesses: false,
    verdict: 'unverifiable',
    reason: 'old_host'
  })
  const router = new DaemonPtyRouter({
    current: createAdapter('current'),
    legacy: [legacy]
  })
  await router.discoverLegacySessions()

  await expect(router.inspectProcess('legacy-session')).resolves.toEqual({
    foregroundProcess: null,
    hasChildProcesses: false,
    verdict: 'unverifiable',
    reason: 'old_host'
  })
})

it('forwards the owning legacy daemon sequence from attach', async () => {
  const legacy = createAdapter('legacy', ['legacy-session'])
  const providerSequence = { value: 204, generation: 'continued' as const }
  vi.mocked(legacy.attach).mockResolvedValueOnce({ providerSequence })
  const router = new DaemonPtyRouter({
    current: createAdapter('current'),
    legacy: [legacy]
  })
  await router.discoverLegacySessions()

  await expect(router.attach('legacy-session')).resolves.toEqual({ providerSequence })
})

describe('DaemonPtyRouter', () => {
  it('advertises runtime-owned transfer framing without enabling live mutation', async () => {
    const router = new DaemonPtyRouter({
      current: createAdapter('current', [], undefined, PROTOCOL_VERSION),
      legacy: []
    })

    await expect(router.getOwnershipBridgeCapabilities()).resolves.toEqual({
      protocolVersions: [1],
      maxReplayBytes: 128 * 1024,
      maxInputIds: 4_096,
      inputDeduplication: true,
      rollback: true,
      liveTransfer: false
    })
  })

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

    it('does not partially retire when a generation predates clean idle shutdown', async () => {
      const current = createAdapter('current', [], undefined, PROTOCOL_VERSION)
      const legacy = createAdapter('legacy', [], undefined, 23)
      const router = new DaemonPtyRouter({ current, legacy: [legacy] })

      await expect(router.requestIdleRetirement()).resolves.toEqual({ state: 'unsupported' })
      expect(current.requestIdleRetirement).not.toHaveBeenCalled()
      expect(legacy.requestIdleRetirement).not.toHaveBeenCalled()
    })

    it('keeps admission fenced after a partial multi-generation retirement', async () => {
      const current = createAdapter('current', [], undefined, PROTOCOL_VERSION)
      const legacy = createAdapter('legacy', [], undefined, PROTOCOL_VERSION)
      vi.mocked(legacy.requestIdleRetirement).mockResolvedValueOnce({
        state: 'busy',
        liveSessions: 0
      })
      const router = new DaemonPtyRouter({ current, legacy: [legacy] })

      await expect(router.requestIdleRetirement()).resolves.toEqual({ state: 'unverifiable' })
      await expect(router.spawn({ sessionId: 'unsafe', cols: 80, rows: 24 })).rejects.toThrow(
        'Terminal daemon is decommissioning'
      )
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
    const current = createAdapter('current', ['current-session'], undefined, PROTOCOL_VERSION)
    const legacy = createAdapter(
      'legacy',
      ['legacy-session'],
      undefined,
      STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION
    )
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

  it('preserves older session owners and routes new sessions to v35', async () => {
    const current = createAdapter('current', [], undefined, PROTOCOL_VERSION)
    const legacyV30 = createAdapter(
      'v30',
      ['v30-session'],
      undefined,
      HISTORY_SEED_TRANSFER_PROTOCOL_VERSION
    )
    const legacyV31 = createAdapter(
      'v31',
      ['v31-session'],
      undefined,
      STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION
    )
    const legacyV32 = createAdapter('v32', ['v32-session'], undefined, 32)
    const legacyV33 = createAdapter('v33', ['v33-session'], undefined, 33)
    const legacyV34 = createAdapter('v34', ['v34-session'], undefined, 34)
    const router = new DaemonPtyRouter({
      current,
      legacy: [legacyV30, legacyV31, legacyV32, legacyV33, legacyV34]
    })

    await router.discoverLegacySessions()

    await router.spawn({ sessionId: 'v30-session', cols: 80, rows: 24 })
    await router.spawn({ sessionId: 'v31-session', cols: 80, rows: 24 })
    await router.spawn({ sessionId: 'v32-session', cols: 80, rows: 24 })
    await router.spawn({ sessionId: 'v33-session', cols: 80, rows: 24 })
    await router.spawn({ sessionId: 'v34-session', cols: 80, rows: 24 })
    const fresh = await router.spawn({ cols: 80, rows: 24 })
    router.write('v30-session', 'old-v30\n')
    router.write('v31-session', 'old-v31\n')
    router.write('v32-session', 'old-v32\n')
    router.write('v33-session', 'old-v33\n')
    router.write('v34-session', 'old-v34\n')
    router.write(fresh.id, 'new\n')

    expect(legacyV30.spawn).toHaveBeenCalledWith({ sessionId: 'v30-session', cols: 80, rows: 24 })
    expect(legacyV31.spawn).toHaveBeenCalledWith({ sessionId: 'v31-session', cols: 80, rows: 24 })
    expect(legacyV32.spawn).toHaveBeenCalledWith({ sessionId: 'v32-session', cols: 80, rows: 24 })
    expect(legacyV33.spawn).toHaveBeenCalledWith({ sessionId: 'v33-session', cols: 80, rows: 24 })
    expect(legacyV34.spawn).toHaveBeenCalledWith({ sessionId: 'v34-session', cols: 80, rows: 24 })
    expect(current.spawn).toHaveBeenCalledWith({ cols: 80, rows: 24 })
    expect(legacyV30.write).toHaveBeenCalledWith('v30-session', 'old-v30\n')
    expect(legacyV31.write).toHaveBeenCalledWith('v31-session', 'old-v31\n')
    expect(legacyV32.write).toHaveBeenCalledWith('v32-session', 'old-v32\n')
    expect(legacyV33.write).toHaveBeenCalledWith('v33-session', 'old-v33\n')
    expect(legacyV34.write).toHaveBeenCalledWith('v34-session', 'old-v34\n')
    expect(current.write).toHaveBeenCalledWith(fresh.id, 'new\n')
  })

  it('routes settlement-aware writes to the owning daemon generation', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', ['legacy-session'])
    vi.mocked(legacy.writeWithSettlement).mockResolvedValue(stubWriteSettlement(false))
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()

    await expect(router.writeWithSettlement('legacy-session', 'pointer')).resolves.toEqual(
      stubWriteSettlement(false)
    )
    expect(legacy.writeWithSettlement).toHaveBeenCalledWith('legacy-session', 'pointer')
    expect(current.writeWithSettlement).not.toHaveBeenCalled()
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

  it('discovers an unmapped live session from one coalesced inventory', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', ['surviving-session'])
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })

    await expect(router.probePtyLiveness('surviving-session')).resolves.toBe(true)
    expect(current.listProcesses).toHaveBeenCalledOnce()
    expect(legacy.listProcesses).toHaveBeenCalledOnce()
    expect(current.probePtyLiveness).not.toHaveBeenCalled()
    expect(legacy.probePtyLiveness).not.toHaveBeenCalled()
  })

  it('does not report absence while any possible daemon owner is unavailable', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy')
    vi.mocked(legacy.listProcesses).mockRejectedValue(new Error('legacy inventory unavailable'))
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })

    await expect(router.probePtyLiveness('unknown-session')).resolves.toBeNull()
  })

  it('reports absence after every possible daemon owner returns a complete inventory', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy')
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })

    await expect(router.probePtyLiveness('missing-session')).resolves.toBe(false)
    expect(current.listProcesses).toHaveBeenCalledOnce()
    expect(legacy.listProcesses).toHaveBeenCalledOnce()
    expect(current.spawn).not.toHaveBeenCalled()
    expect(legacy.spawn).not.toHaveBeenCalled()
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

  it('still routes probes for a discovered session to its owning legacy daemon', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', ['legacy-session'])
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()

    await expect(router.probePtyLiveness('legacy-session')).resolves.toBe(true)
    expect(legacy.probePtyLiveness).toHaveBeenCalledExactlyOnceWith('legacy-session')
  })

  it('keeps consulting a legacy daemon whose inventory listing failed', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', ['legacy-session'])
    vi.mocked(legacy.listProcesses).mockRejectedValue(new Error('wedged'))
    vi.mocked(legacy.probePtyLiveness).mockResolvedValue(null)
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()

    // Without an inventory nothing proves the legacy daemon doesn't own this id.
    await expect(router.probePtyLiveness('unknown-session')).resolves.toBeNull()
    expect(legacy.listProcesses).toHaveBeenCalledTimes(2)
    expect(legacy.probePtyLiveness).not.toHaveBeenCalled()
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

  it('fails listProcesses closed when any routed adapter cannot list sessions', async () => {
    const current = createAdapter('current', ['current-session'])
    const legacy = createAdapter('legacy', ['legacy-session'])
    vi.mocked(legacy.listProcesses).mockRejectedValueOnce(new Error('legacy unavailable'))
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })

    await expect(router.listProcesses()).rejects.toThrow('legacy unavailable')
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

  it('pins colliding unmapped legacy ids falling through to the current daemon', async () => {
    const sessionId = 'cross-generation-collision'
    const current = createAdapter('current', [sessionId])
    const legacy = createAdapter('legacy', [sessionId])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(legacy.listProcesses).mockRejectedValueOnce(new Error('legacy discovery failed'))
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })

    await router.discoverLegacySessions()
    router.write(sessionId, 'misrouted\n')

    expect(current.write).toHaveBeenCalledWith(sessionId, 'misrouted\n')
    expect(legacy.write).not.toHaveBeenCalled()
    warn.mockRestore()
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
