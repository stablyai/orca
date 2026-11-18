import '../../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonClient } from '../../../transport/client/daemon-client'
import { DaemonPtyAdapter } from '../daemon-pty-adapter'
import { LIVENESS_PROBE_TIMEOUT_MS } from '../daemon-pty-session-control'
import {
  COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION,
  GET_FOREGROUND_PROCESS_PROTOCOL_VERSION,
  GET_SIZE_PROTOCOL_VERSION
} from '../../../protocol/daemon-protocol-version'
import type { DaemonServer } from '../../../server/daemon-server'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'
import type * as DaemonHealthModule from '../../../health/daemon-health'
import type * as DaemonTccAttributionModule from '../../../permissions/daemon-tcc-attribution'

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

vi.mock('../../../health/daemon-health', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonHealthModule>()
  return {
    ...actual,
    getMacDaemonSystemResolverHealth: getMacDaemonSystemResolverHealthMock
  }
})

vi.mock('../../../permissions/daemon-tcc-attribution', async (importOriginal) => {
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

  describe('background stream thinning compatibility', () => {
    // Provider fallback can route unknown IDs here; false authority would let the renderer discard their panes.
    it('refuses an authoritative snapshot claim for a session it does not own', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })

      expect(adapter.canProvideAuthoritativeBufferSnapshot(id)).toBe(true)
      expect(adapter.canProvideAuthoritativeBufferSnapshot('remote:env-1:pty-1')).toBe(false)
      expect(adapter.canProvideAuthoritativeBufferSnapshot('never-spawned-session')).toBe(false)
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

    // Legacy inventory must prove absence or one unsupported getSize can block retirement across the owner fanout.

    // getSize shipped without a protocol bump; the reported version alone cannot prove support.

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

    it('rejects rather than reading as idle when the daemon call fails', async () => {
      // getForegroundProcess suppresses transport errors; using it here would falsely report agent completion.
      const legacy = createInspectionAdapter(
        COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION - 1,
        vi.fn(async () => {
          throw new Error('socket_closed')
        })
      )

      await expect(legacy.inspectProcess('sess-a')).rejects.toThrow('socket_closed')

      legacy.dispose()
    })
  })
})
