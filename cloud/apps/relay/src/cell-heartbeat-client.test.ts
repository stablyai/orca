import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RelayConfig } from './config.js'
import { startCellHeartbeat } from './cell-heartbeat-client.js'

const CONFIG = {
  role: 'cell',
  cellId: 'cell-a',
  cellUrl: 'https://relay-a.example.com',
  directorUrl: 'https://relay.example.com',
  heartbeatAudience: 'https://relay.example.com/v1/admin/cell-heartbeat'
} as RelayConfig

describe('cell heartbeat client', () => {
  afterEach(() => vi.restoreAllMocks())

  it('sends an immediate authenticated heartbeat without putting credentials in the URL', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init })
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const client = startCellHeartbeat(CONFIG, {
      ready: async () => true,
      observedRequests: () => 7,
      connectionCounts: () => ({
        totalConnections: 0,
        inFlightConnections: 0,
        reservedConnectionUnits: 0,
        enforcedConnectionUnits: 0
      }),
      fetch: fetchImpl,
      identityToken: async () => 'secret-token',
      now: () => 123,
      incarnation: '11111111-1111-4111-8111-111111111111',
      intervalMs: 60_000
    })!
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    client.stop()

    expect(requests[0]!.url).toBe('https://relay.example.com/v1/admin/cell-heartbeat')
    expect(requests[0]!.url).not.toContain('secret-token')
    expect(requests[0]!.init?.headers).toMatchObject({ authorization: 'Bearer secret-token' })
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
      v: 1,
      cellId: 'cell-a',
      cellUrl: 'https://relay-a.example.com',
      region: 'us-central1',
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      startedAt: 123,
      ready: true,
      observedRequests: 7
    })
  })

  it('advertises per-host drain only when its dedicated trust boundary is configured', async () => {
    const requests: RequestInit[] = []
    const client = startCellHeartbeat(
      {
        ...CONFIG,
        rehomeAudience: 'https://relay.example.com/v1/admin/host-drain',
        rehomeDirectorServiceAccount: 'relay-director@example.com'
      },
      {
        ready: async () => true,
        observedRequests: () => 0,
        connectionCounts: () => ({
          totalConnections: 0,
          inFlightConnections: 0,
          reservedConnectionUnits: 0,
          enforcedConnectionUnits: 0
        }),
        regionalRehomeSafety: () => ({
          observedAt: 120,
          sqlFailures: 0,
          reconnects: 2,
          controlActivityRecoveryFailures: 0,
          databasePoolWaiting: 0,
          databasePoolWaitersMax: 0,
          databasePoolWaitMsMax: 0
        }),
        fetch: async (_input, init) => {
          requests.push(init ?? {})
          return new Response('{}', { status: 200 })
        },
        identityToken: async () => 'secret-token',
        now: () => 123,
        incarnation: '11111111-1111-4111-8111-111111111111',
        intervalMs: 60_000
      }
    )!
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    client.stop()

    expect(JSON.parse(String(requests[1]!.body))).toMatchObject({
      regionalRehomeProtocol: 1,
      safety: {
        observedAt: 120,
        sqlFailures: 0,
        reconnects: 2,
        controlActivityRecoveryFailures: 0,
        databasePoolWaiting: 0,
        databasePoolWaitersMax: 0,
        databasePoolWaitMsMax: 0
      }
    })
  })

  it('reports the complete enforced connection ledger for a limited cell', async () => {
    const requests: RequestInit[] = []
    const client = startCellHeartbeat(
      {
        ...CONFIG,
        connectionHardCap: 600,
        connectionUnobservedBound: 60
      },
      {
        ready: async () => true,
        observedRequests: () => 9,
        connectionCounts: () => ({
          totalConnections: 10,
          inFlightConnections: 2,
          reservedConnectionUnits: 3,
          enforcedConnectionUnits: 15,
          inclusionWatermark: 42
        }),
        fetch: async (_input, init) => {
          requests.push(init ?? {})
          return new Response('{}', { status: 200 })
        },
        identityToken: async () => 'secret-token',
        now: () => 123,
        incarnation: '11111111-1111-4111-8111-111111111111',
        intervalMs: 60_000
      }
    )!
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    client.stop()

    expect(JSON.parse(String(requests[0]!.body))).toMatchObject({
      totalConnections: 10,
      inFlightConnections: 2,
      reservedConnectionUnits: 3,
      enforcedConnectionUnits: 15,
      connectionInclusionWatermark: 42,
      connectionHardCap: 600,
      connectionUnobservedBound: 60
    })
  })

  it('does not start outside an explicitly configured cell role', () => {
    expect(
      startCellHeartbeat({ ...CONFIG, role: 'director' }, {
        ready: async () => true,
        observedRequests: () => 0,
        connectionCounts: () => ({
          totalConnections: 0,
          inFlightConnections: 0,
          reservedConnectionUnits: 0,
          enforcedConnectionUnits: 0
        })
      })
    ).toBeNull()
    expect(
      startCellHeartbeat({ ...CONFIG, directorUrl: undefined }, {
        ready: async () => true,
        observedRequests: () => 0,
        connectionCounts: () => ({
          totalConnections: 0,
          inFlightConnections: 0,
          reservedConnectionUnits: 0,
          enforcedConnectionUnits: 0
        })
      })
    ).toBeNull()
  })
})
