import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RelayConfig } from '../config.js'
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

})
