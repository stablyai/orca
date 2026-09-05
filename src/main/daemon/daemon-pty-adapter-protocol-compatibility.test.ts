/* DaemonPtyAdapter behaviour that varies with the negotiated daemon protocol version. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { LIVENESS_PROBE_TIMEOUT_MS } from './daemon-pty-session-control'
import {
  COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION,
  GET_FOREGROUND_PROCESS_PROTOCOL_VERSION,
  GET_SIZE_PROTOCOL_VERSION,
  PROTOCOL_VERSION
} from './daemon-protocol-version'
import type { DaemonServer } from './daemon-server'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'
import type * as DaemonHealthModule from './daemon-health'
import type * as DaemonTccAttributionModule from './daemon-tcc-attribution'

const { getMacDaemonSystemResolverHealthMock, getMacDaemonTccAttributionHealthMock } = vi.hoisted(
  () => ({
    getMacDaemonSystemResolverHealthMock: vi.fn(
      async (): Promise<'unknown' | 'unhealthy'> => 'unknown'
    ),
    getMacDaemonTccAttributionHealthMock: vi.fn(
      async (): Promise<'intact' | 'severed' | 'unknown'> => 'unknown'
    )
  })
)

vi.mock('./daemon-health', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonHealthModule>()
  return {
    ...actual,
    getMacDaemonSystemResolverHealth: getMacDaemonSystemResolverHealthMock
  }
})

vi.mock('./daemon-tcc-attribution', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonTccAttributionModule>()
  return {
    ...actual,
    getMacDaemonTccAttributionHealth: getMacDaemonTccAttributionHealthMock
  }
})

describe('DaemonPtyAdapter (IPtyProvider)', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter

  beforeEach(async () => {
    const harness = await startDaemonAdapterHarness(() => {
      return createMockSubprocess()
    })
    dir = harness.dir
    socketPath = harness.socketPath
    tokenPath = harness.tokenPath
    server = harness.server
    adapter = harness.adapter
    getMacDaemonSystemResolverHealthMock.mockReset()
    getMacDaemonSystemResolverHealthMock.mockResolvedValue('unknown')
    getMacDaemonTccAttributionHealthMock.mockReset()
    getMacDaemonTccAttributionHealthMock.mockResolvedValue('unknown')
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('mode 2031 fact compatibility (#9993)', () => {
    let onEventSpy: ReturnType<typeof vi.spyOn>
    // Why these tests exist: daemons survive app updates, so a NEW desktop can be
    // driving a PRESERVED older daemon. Those daemons emit '2031-subscribe' but have
    // no unsubscribe fact at all. For a gate-managed pane the renderer never sees the
    // bytes, so main's facts are the only thing that can retire the subscription —
    // trusting a subscribe that can never be retracted leaves it live forever, and the
    // next theme flip injects CSI 997 into whatever shell replaced the exited TUI.
    function captureForwardedFacts(target: DaemonPtyAdapter): {
      kinds: () => string[]
      emit: (fact: { kind: string }) => void
    } {
      const forwarded: string[] = []
      target.onBackgroundStreamEvent((payload) => {
        if (payload.kind === 'transientFact') {
          forwarded.push((payload.fact as { kind: string }).kind)
        }
      })
      const listeners: ((event: unknown) => void)[] = []
      onEventSpy = vi.spyOn(DaemonClient.prototype, 'onEvent').mockImplementation((listener) => {
        listeners.push(listener)
        return () => {}
      })
      return {
        kinds: () => forwarded,
        emit: (fact) => {
          expect(listeners.length).toBeGreaterThan(0)
          for (const listener of listeners) {
            // `type: 'event'` is the envelope the routing switch requires.
            listener({
              type: 'event',
              event: 'transientFact',
              sessionId: 'session-1',
              payload: fact
            })
          }
        }
      }
    }

    it('drops a pre-v29 daemon 2031-subscribe it could never retract', () => {
      // v28 is the version shipping today, so this is the live upgrade hazard: a v28
      // daemon preserved across an app update, still holding real sessions.
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 28 })
      try {
        const captured = captureForwardedFacts(legacy)
        // Force a fresh wire-up so the spy above is the listener the adapter installs.
        legacy['removeEventListener'] = null
        legacy['setupEventRouting']()
        captured.emit({ kind: '2031-subscribe' })
        captured.emit({ kind: 'bell' })

        // The unretractable subscribe is withheld; unrelated facts still flow, so the
        // gate is narrow rather than "ignore this daemon's facts".
        expect(captured.kinds()).toEqual(['bell'])
      } finally {
        legacy.dispose()
        onEventSpy.mockRestore()
      }
    })

    it('never delegates scan authority to a v28 daemon, so a hidden withdrawal is still seen', () => {
      // The scenario the fact filter alone does NOT cover, and the reason the gate sits
      // on backgrounding: while the pane is VISIBLE, main's own scanner registers the
      // 2031 subscribe (bytes transit main either way). Only backgrounding hands scan
      // authority to the daemon. If a v28 daemon were allowed to take it, the TUI could
      // exit while hidden with no party able to emit the withdrawal — #9993 via upgrade.
      const notifySpy = vi.spyOn(DaemonClient.prototype, 'notify')
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 28 })
      try {
        legacy.setPtyBackgrounded('v28-session', true)
        expect(notifySpy).toHaveBeenCalledWith('setSessionBackground', {
          sessionId: 'v28-session',
          background: false
        })
      } finally {
        legacy.dispose()
        notifySpy.mockRestore()
      }
    })

    it('delegates scan authority to a v32 daemon with faithful snapshots', () => {
      const notifySpy = vi.spyOn(DaemonClient.prototype, 'notify')
      const current = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 32 })
      try {
        current.setPtyBackgrounded('v32-session', true)
        expect(notifySpy).toHaveBeenCalledWith('setSessionBackground', {
          sessionId: 'v32-session',
          background: true
        })
      } finally {
        current.dispose()
        notifySpy.mockRestore()
      }
    })

    it('forwards a provisional subscribe with the foreground handoff marker', () => {
      const current = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 29 })
      const forwarded: unknown[] = []
      current.onBackgroundStreamEvent((payload) => forwarded.push(payload))
      const listeners: ((event: unknown) => void)[] = []
      onEventSpy = vi.spyOn(DaemonClient.prototype, 'onEvent').mockImplementation((listener) => {
        listeners.push(listener)
        return () => {}
      })
      try {
        current['removeEventListener'] = null
        current['setupEventRouting']()
        for (const listener of listeners) {
          listener({
            type: 'event',
            event: 'sessionBackgroundMarker',
            sessionId: 'session-1',
            payload: {
              background: false,
              scanSeedAnsi: '\x1b[?',
              mode2031PendingSubscribe: true
            }
          })
        }

        expect(forwarded).toEqual([
          {
            id: 'session-1',
            kind: 'backgroundMarker',
            background: false,
            scanSeedAnsi: '\x1b[?',
            mode2031PendingSubscribe: true
          }
        ])
      } finally {
        current.dispose()
        onEventSpy.mockRestore()
      }
    })

    it('forwards a v28 unsubscribe, which can only retire state main registered', () => {
      // Asymmetric on purpose: an unretractable subscribe is the hazard, a withdrawal
      // never is. A stale relay tracker on a preserved daemon must still be able to
      // clear a subscription rather than be silenced into stranding it.
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 28 })
      try {
        const captured = captureForwardedFacts(legacy)
        legacy['removeEventListener'] = null
        legacy['setupEventRouting']()
        captured.emit({ kind: '2031-unsubscribe' })

        expect(captured.kinds()).toEqual(['2031-unsubscribe'])
      } finally {
        legacy.dispose()
        onEventSpy.mockRestore()
      }
    })

    it('forwards 2031 facts from a v29 daemon that can retract them', () => {
      const current = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 29 })
      try {
        const captured = captureForwardedFacts(current)
        current['removeEventListener'] = null
        current['setupEventRouting']()
        captured.emit({ kind: '2031-subscribe' })
        captured.emit({ kind: '2031-unsubscribe' })

        expect(captured.kinds()).toEqual(['2031-subscribe', '2031-unsubscribe'])
      } finally {
        current.dispose()
        onEventSpy.mockRestore()
      }
    })
  })

  describe('background stream thinning compatibility', () => {
    it('reports authoritative snapshot support only for the corrected serializer protocol', () => {
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 31 })
      try {
        expect(legacy.canProvideAuthoritativeBufferSnapshot('legacy-session')).toBe(false)
        expect(adapter.canProvideAuthoritativeBufferSnapshot('current-session')).toBe(true)
      } finally {
        legacy.dispose()
      }
    })

    it('reports background state on the authoritative-snapshot protocol', () => {
      const notifySpy = vi.spyOn(DaemonClient.prototype, 'notify')
      try {
        adapter.setPtyBackgrounded('current-session', true)
        expect(notifySpy).toHaveBeenCalledWith('setSessionBackground', {
          sessionId: 'current-session',
          background: true
        })
      } finally {
        notifySpy.mockRestore()
      }
    })

    it('keeps preserved v31 sessions unthinned because their snapshots can corrupt replay', () => {
      const notifySpy = vi.spyOn(DaemonClient.prototype, 'notify')
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 31 })
      try {
        legacy.setPtyBackgrounded('legacy-session', true)
        expect(notifySpy).toHaveBeenCalledWith('setSessionBackground', {
          sessionId: 'legacy-session',
          background: false
        })
      } finally {
        legacy.dispose()
        notifySpy.mockRestore()
      }
    })

    it('clears a preserved v31 background hint before attaching its stream', async () => {
      const ensureConnectedSpy = vi
        .spyOn(DaemonClient.prototype, 'ensureConnected')
        .mockResolvedValue()
      const requestSpy = vi.spyOn(DaemonClient.prototype, 'request').mockResolvedValue({
        isNew: true,
        pid: null,
        shellState: 'unsupported',
        snapshot: null
      } as never)
      const notifySpy = vi.spyOn(DaemonClient.prototype, 'notify')
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 31 })
      try {
        await legacy.spawn({ sessionId: 'legacy-session', cols: 80, rows: 24 })

        expect(notifySpy).toHaveBeenCalledWith('setSessionBackground', {
          sessionId: 'legacy-session',
          background: false
        })
        expect(notifySpy.mock.invocationCallOrder[0]).toBeLessThan(
          requestSpy.mock.invocationCallOrder[0]
        )
      } finally {
        legacy.dispose()
        notifySpy.mockRestore()
        requestSpy.mockRestore()
        ensureConnectedSpy.mockRestore()
      }
    })

    it.each([
      { protocolVersion: 28, clearsHint: true },
      { protocolVersion: 29, clearsHint: true },
      { protocolVersion: 31, clearsHint: true },
      { protocolVersion: 32, clearsHint: false }
    ])(
      'uses protocol v$protocolVersion background authority before spawn',
      async ({ protocolVersion, clearsHint }) => {
        const ensureConnectedSpy = vi
          .spyOn(DaemonClient.prototype, 'ensureConnected')
          .mockResolvedValue()
        const requestSpy = vi.spyOn(DaemonClient.prototype, 'request').mockResolvedValue({
          isNew: true,
          pid: null,
          shellState: 'unsupported',
          snapshot: null
        } as never)
        const notifySpy = vi.spyOn(DaemonClient.prototype, 'notify')
        const target = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion })
        const sessionId = `spawn-v${protocolVersion}-session`
        try {
          await target.spawn({ sessionId, cols: 80, rows: 24 })

          if (clearsHint) {
            expect(notifySpy).toHaveBeenCalledWith('setSessionBackground', {
              sessionId,
              background: false
            })
            expect(notifySpy.mock.invocationCallOrder[0]).toBeLessThan(
              requestSpy.mock.invocationCallOrder[0]
            )
          } else {
            expect(notifySpy).not.toHaveBeenCalledWith(
              'setSessionBackground',
              expect.objectContaining({ sessionId })
            )
          }
        } finally {
          target.dispose()
          notifySpy.mockRestore()
          requestSpy.mockRestore()
          ensureConnectedSpy.mockRestore()
        }
      }
    )

    it('clears a preserved v28 background hint before attaching, so scan authority comes home', async () => {
      // The gate on setPtyBackgrounded only binds THIS process. Daemons outlive the desktop:
      // a v28 that a previous desktop backgrounded is still scanning when a new desktop
      // attaches, and this process never called setPtyBackgrounded for it — so without the
      // pre-attach clear the daemon keeps authority it can never retract (#9993).
      const ensureConnectedSpy = vi
        .spyOn(DaemonClient.prototype, 'ensureConnected')
        .mockResolvedValue()
      const requestSpy = vi
        .spyOn(DaemonClient.prototype, 'request')
        .mockImplementation(async (type: string) =>
          type === 'getSize'
            ? ({ size: { cols: 80, rows: 24 } } as never)
            : ({ isNew: false, pid: 4242, shellState: 'unsupported', snapshot: null } as never)
        )
      const notifySpy = vi.spyOn(DaemonClient.prototype, 'notify')
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 28 })
      try {
        await legacy.attach('preserved-v28-session')

        expect(notifySpy).toHaveBeenCalledWith('setSessionBackground', {
          sessionId: 'preserved-v28-session',
          background: false
        })
        expect(notifySpy.mock.invocationCallOrder[0]).toBeLessThan(
          requestSpy.mock.invocationCallOrder[0]
        )
      } finally {
        legacy.dispose()
        notifySpy.mockRestore()
        requestSpy.mockRestore()
        ensureConnectedSpy.mockRestore()
      }
    })

    it('leaves a v32 background hint alone on attach', async () => {
      const ensureConnectedSpy = vi
        .spyOn(DaemonClient.prototype, 'ensureConnected')
        .mockResolvedValue()
      const requestSpy = vi
        .spyOn(DaemonClient.prototype, 'request')
        .mockImplementation(async (type: string) =>
          type === 'getSize'
            ? ({ size: { cols: 80, rows: 24 } } as never)
            : ({ isNew: false, pid: 4242, shellState: 'unsupported', snapshot: null } as never)
        )
      const notifySpy = vi.spyOn(DaemonClient.prototype, 'notify')
      const current = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 32 })
      try {
        await current.attach('preserved-v32-session')

        expect(notifySpy).not.toHaveBeenCalledWith(
          'setSessionBackground',
          expect.objectContaining({ sessionId: 'preserved-v32-session' })
        )
      } finally {
        current.dispose()
        notifySpy.mockRestore()
        requestSpy.mockRestore()
        ensureConnectedSpy.mockRestore()
      }
    })

    it('still returns the v31 attach snapshot so desktop replay retains shell history', async () => {
      const ensureConnectedSpy = vi
        .spyOn(DaemonClient.prototype, 'ensureConnected')
        .mockResolvedValue()
      const requestSpy = vi.spyOn(DaemonClient.prototype, 'request').mockResolvedValue({
        isNew: false,
        pid: 123,
        shellState: 'unsupported',
        snapshot: {
          scrollbackAnsi: 'legacy history\r\n',
          rehydrateSequences: '\x1b[?2004h',
          snapshotAnsi: 'legacy prompt',
          modes: { alternateScreen: false },
          cols: 80,
          rows: 24
        }
      } as never)
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 31 })
      try {
        const result = await legacy.spawn({ sessionId: 'legacy-session', cols: 80, rows: 24 })

        expect(result).toMatchObject({
          id: 'legacy-session',
          isReattach: true,
          snapshot: expect.stringContaining('legacy history')
        })
        expect(result.snapshot).toContain('legacy prompt')
        expect(result.providerSequence).toBeUndefined()
        await expect(legacy.getBufferSnapshot('legacy-session')).resolves.toBeNull()
      } finally {
        legacy.dispose()
        requestSpy.mockRestore()
        ensureConnectedSpy.mockRestore()
      }
    })
  })

  describe('probePtyLiveness', () => {
    it('reads daemon truth before a fresh adapter has attached the session', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      const activeSessionIds = (adapter as unknown as { activeSessionIds: Set<string> })
        .activeSessionIds
      activeSessionIds.clear()

      expect(adapter.hasPty(id)).toBe(false)
      await expect(adapter.probePtyLiveness(id)).resolves.toBe(true)
      await expect(adapter.probePtyLiveness('missing-session')).resolves.toBe(false)
    })

    it('returns unknown when the daemon cannot answer', async () => {
      const client = (
        adapter as unknown as {
          client: { request: (type: string, payload?: unknown) => Promise<unknown> }
        }
      ).client
      vi.spyOn(client, 'request').mockRejectedValueOnce(new Error('unavailable'))

      await expect(adapter.probePtyLiveness('session')).resolves.toBeNull()
    })

    function createProbeAdapter(
      protocolVersion: number,
      request: ReturnType<typeof vi.fn>
    ): DaemonPtyAdapter {
      const probeAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion })
      ;(
        probeAdapter as unknown as {
          client: { request: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }
        }
      ).client = { request, disconnect: vi.fn() }
      return probeAdapter
    }

    // Why: a pre-v18 daemon rejects `getSize` as an unknown request type, so it would answer
    // `null` forever — and one `null` makes the owner fan-out permanently unprovable, which
    // would leave a genuinely dead pane unable to ever retire and respawn.
    it('answers a pre-getSize daemon from its session inventory', async () => {
      // Faithful pre-v18 daemon: routeRequest falls through its switch and error-replies.
      const request = vi.fn(async (type: string) => {
        if (type !== 'listSessions') {
          throw new Error(`Unknown request type: ${type}`)
        }
        return {
          sessions: [
            { sessionId: 'legacy-live', isAlive: true },
            { sessionId: 'legacy-exited', isAlive: false }
          ]
        }
      })
      const legacy = createProbeAdapter(GET_SIZE_PROTOCOL_VERSION - 1, request)

      await expect(legacy.probePtyLiveness('legacy-live')).resolves.toBe(true)
      await expect(legacy.probePtyLiveness('legacy-exited')).resolves.toBe(false)
      await expect(legacy.probePtyLiveness('never-existed')).resolves.toBe(false)
      expect(request).toHaveBeenCalledWith('listSessions', undefined, LIVENESS_PROBE_TIMEOUT_MS)
      expect(request).not.toHaveBeenCalledWith('getSize', expect.anything())

      legacy.dispose()
    })

    // The P0 boundary: an owner that cannot be reached must never read as one that answered "absent".
    it('still answers unknown when a pre-getSize daemon cannot be reached', async () => {
      const request = vi.fn(async () => {
        throw new Error('Not connected')
      })
      const legacy = createProbeAdapter(GET_SIZE_PROTOCOL_VERSION - 1, request)

      await expect(legacy.probePtyLiveness('legacy-live')).resolves.toBeNull()

      legacy.dispose()
    })

    // Why: `getSize` shipped into an already-released protocol without a version bump, so a
    // daemon can report a version that implies support and still reject the request. Gating on
    // the number alone left those daemons permanently unprovable — the same wedge, narrowed.
    it('falls back when a daemon rejects getSize despite reporting a version that has it', async () => {
      const request = vi.fn(async (type: string) => {
        if (type === 'getSize') {
          throw new Error(`Unknown request type: ${type}`)
        }
        return { sessions: [{ sessionId: 'ambiguous-live', isAlive: true }] }
      })
      const ambiguous = createProbeAdapter(GET_SIZE_PROTOCOL_VERSION, request)

      await expect(ambiguous.probePtyLiveness('ambiguous-live')).resolves.toBe(true)
      await expect(ambiguous.probePtyLiveness('never-existed')).resolves.toBe(false)

      // The rejection is remembered, so later probes skip the round trip that cannot work.
      expect(request.mock.calls.filter(([type]) => type === 'getSize')).toHaveLength(1)
      // Why pinned here: a wedged daemon holds its socket open, so an unbounded getSize would
      // stall a pane mount for the client's 30s default instead of answering "unknown" in 2s.
      expect(request).toHaveBeenCalledWith(
        'getSize',
        { sessionId: 'ambiguous-live' },
        LIVENESS_PROBE_TIMEOUT_MS
      )

      ambiguous.dispose()
    })

    // The safety direction: only the daemon's own "I do not implement that" may switch strategy.
    // A transient failure must stay unproven rather than be retried as a capability question.
    it('keeps a transient getSize failure unproven instead of treating it as unsupported', async () => {
      const request = vi.fn(async (type: string) => {
        if (type === 'getSize') {
          throw new Error('Connection lost')
        }
        return { sessions: [] }
      })
      const flaky = createProbeAdapter(GET_SIZE_PROTOCOL_VERSION, request)

      await expect(flaky.probePtyLiveness('live-elsewhere')).resolves.toBeNull()
      expect(request).not.toHaveBeenCalledWith('listSessions', undefined, LIVENESS_PROBE_TIMEOUT_MS)

      flaky.dispose()
    })
  })

  describe('attach applied-size compatibility', () => {
    function mockAttachRequest(args: {
      sessionId: string
      cols: number
      rows: number
      protocolVersion: number
      getSizeError?: Error
      getSizeResponse?: { size: { cols: number; rows: number } | null }
    }): {
      request: ReturnType<typeof vi.spyOn>
      ensureConnected: ReturnType<typeof vi.spyOn>
      adapter: DaemonPtyAdapter
    } {
      const ensureConnected = vi
        .spyOn(DaemonClient.prototype, 'ensureConnected')
        .mockResolvedValue()
      const request = vi
        .spyOn(DaemonClient.prototype, 'request')
        .mockImplementation(async (type: string) => {
          if (type === 'getSize') {
            if (args.getSizeError) {
              throw args.getSizeError
            }
            return (args.getSizeResponse ?? { size: null }) as never
          }
          if (type === 'listSessions') {
            return {
              sessions: [
                {
                  sessionId: args.sessionId,
                  isAlive: true,
                  cols: args.cols,
                  rows: args.rows
                }
              ]
            } as never
          }
          if (type === 'createOrAttach') {
            return {
              isNew: false,
              snapshot: null,
              pid: 4321,
              shellState: 'unsupported',
              incarnationId: 'compat-attach-incarnation'
            } as never
          }
          return {} as never
        })
      const adapter = new DaemonPtyAdapter({
        socketPath,
        tokenPath,
        protocolVersion: args.protocolVersion
      })
      return { request, ensureConnected, adapter }
    }

    it('uses inventory dimensions when attaching to a pre-getSize daemon', async () => {
      const sessionId = 'legacy-v17-session'
      const rig = mockAttachRequest({
        sessionId,
        cols: 137,
        rows: 41,
        protocolVersion: GET_SIZE_PROTOCOL_VERSION - 1
      })
      try {
        await expect(rig.adapter.attach(sessionId)).resolves.toBeUndefined()
        expect(rig.request).not.toHaveBeenCalledWith('getSize', expect.anything())
        expect(rig.request).toHaveBeenCalledWith('listSessions', undefined)
        expect(rig.request).toHaveBeenCalledWith(
          'createOrAttach',
          expect.objectContaining({ sessionId, cols: 137, rows: 41 })
        )
      } finally {
        rig.adapter.dispose()
        rig.request.mockRestore()
        rig.ensureConnected.mockRestore()
      }
    })

    it('falls back to inventory when a versioned daemon rejects getSize', async () => {
      const sessionId = 'ambiguous-get-size-session'
      const rig = mockAttachRequest({
        sessionId,
        cols: 120,
        rows: 30,
        protocolVersion: GET_SIZE_PROTOCOL_VERSION,
        getSizeError: new Error('Unknown request type: getSize')
      })
      try {
        await expect(rig.adapter.attach(sessionId)).resolves.toBeUndefined()
        expect(rig.request).toHaveBeenCalledWith('listSessions', undefined)
        expect(rig.request).toHaveBeenCalledWith(
          'createOrAttach',
          expect.objectContaining({ sessionId, cols: 120, rows: 30 })
        )
      } finally {
        rig.adapter.dispose()
        rig.request.mockRestore()
        rig.ensureConnected.mockRestore()
      }
    })

    it('preserves a size-probe transport failure as unverifiable', async () => {
      const transportError = new Error('Connection lost')
      const rig = mockAttachRequest({
        sessionId: 'disconnected-attach-session',
        cols: 80,
        rows: 24,
        protocolVersion: GET_SIZE_PROTOCOL_VERSION,
        getSizeError: transportError
      })
      try {
        await expect(rig.adapter.attach('disconnected-attach-session')).rejects.toBe(transportError)
        expect(rig.request).not.toHaveBeenCalledWith('createOrAttach', expect.anything())
      } finally {
        rig.adapter.dispose()
        rig.request.mockRestore()
        rig.ensureConnected.mockRestore()
      }
    })
  })

  describe('inspectProcess on pre-inspection daemon protocols', () => {
    type ClientInternals = {
      client: { request: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }
    }

    function createInspectionAdapter(
      protocolVersion: number,
      request: ReturnType<typeof vi.fn>
    ): DaemonPtyAdapter {
      const inspectionAdapter = new DaemonPtyAdapter({
        socketPath,
        tokenPath,
        protocolVersion
      })
      ;(inspectionAdapter as unknown as ClientInternals).client = {
        request,
        disconnect: vi.fn()
      }
      return inspectionAdapter
    }

    it('reports protocol 10 inspection as client-only unverifiable without unsupported RPCs', async () => {
      const request = vi.fn()
      const legacy = createInspectionAdapter(GET_FOREGROUND_PROCESS_PROTOCOL_VERSION - 1, request)

      await expect(legacy.inspectProcess('sess-a')).resolves.toEqual({
        foregroundProcess: null,
        hasChildProcesses: false,
        verdict: 'unverifiable',
        reason: 'old_host'
      })
      await expect(legacy.getForegroundProcess('sess-a')).resolves.toBeNull()
      await expect(legacy.hasChildProcesses('sess-a')).resolves.toBe(true)
      expect(request).not.toHaveBeenCalled()

      legacy.dispose()
    })

    it.each([
      GET_FOREGROUND_PROCESS_PROTOCOL_VERSION,
      COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION - 1
    ])('composes protocol %s inspection from getForegroundProcess', async (protocolVersion) => {
      const request = vi.fn(async () => ({ foregroundProcess: 'codex' }))
      const legacy = createInspectionAdapter(protocolVersion, request)

      expect(await legacy.inspectProcess('sess-a')).toEqual({
        foregroundProcess: 'codex',
        hasChildProcesses: true
      })
      expect(request).toHaveBeenCalledWith('getForegroundProcess', { sessionId: 'sess-a' })
      expect(request).not.toHaveBeenCalledWith('inspectProcess', expect.anything())

      legacy.dispose()
    })

    it('reports an idle shell as having no child processes', async () => {
      const legacy = createInspectionAdapter(
        COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION - 1,
        vi.fn(async () => ({ foregroundProcess: 'bash' }))
      )

      expect(await legacy.inspectProcess('sess-a')).toEqual({
        foregroundProcess: 'bash',
        hasChildProcesses: false
      })

      legacy.dispose()
    })

    it('reports a null foreground as idle, matching what the legacy daemon can report', async () => {
      const legacy = createInspectionAdapter(
        COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION - 1,
        vi.fn(async () => ({ foregroundProcess: null }))
      )

      expect(await legacy.inspectProcess('sess-a')).toEqual({
        foregroundProcess: null,
        hasChildProcesses: false
      })

      legacy.dispose()
    })

    it('rejects rather than reading as idle when the daemon call fails', async () => {
      // Why: getForegroundProcess swallows errors into null; composing through it would turn a dead
      // socket into a false "agent exited" completion, the mirror of the bug this path fixes.
      const legacy = createInspectionAdapter(
        COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION - 1,
        vi.fn(async () => {
          throw new Error('socket_closed')
        })
      )

      await expect(legacy.inspectProcess('sess-a')).rejects.toThrow('socket_closed')

      legacy.dispose()
    })

    it.each([COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION, PROTOCOL_VERSION])(
      'delegates protocol %s inspection to inspectProcess',
      async (protocolVersion) => {
        const request = vi.fn(async () => ({ foregroundProcess: 'codex', hasChildProcesses: true }))
        const current = createInspectionAdapter(protocolVersion, request)

        await current.inspectProcess('sess-a')

        expect(request).toHaveBeenCalledWith('inspectProcess', { sessionId: 'sess-a' })

        current.dispose()
      }
    )

    it('forwards the optional incarnation fence to a current daemon', async () => {
      const request = vi.fn(async () => ({ foregroundProcess: null, hasChildProcesses: false }))
      const current = createInspectionAdapter(PROTOCOL_VERSION, request)

      await current.inspectProcess('sess-a', { expectedIncarnationId: 'incarnation-a' })

      expect(request).toHaveBeenCalledWith('inspectProcess', {
        sessionId: 'sess-a',
        expectedIncarnationId: 'incarnation-a'
      })
      current.dispose()
    })
  })
})
