import { describe, expect, it, vi } from 'vitest'
import type { RelayConfig } from './config.js'

const fakes = vi.hoisted(() => ({
  verifyRelayToken: vi.fn(async (token: string) => ({ sub: 'user-1', relayHostId: token }))
}))

vi.mock('./authentication/relay-token-verifier.js', () => ({
  createRelayTokenVerifier: () => fakes.verifyRelayToken,
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

import { createRelayApp } from './app.js'

describe('Relay region API', () => {

  it('returns successful placement when optional window storage is unavailable', async () => {
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: {
        assign: async () => ({
          cellId: 'asia-c1',
          region: 'asia-east2',
          cellUrl: 'https://asia-c1.relay.example.test',
          assignmentEpoch: 7
        }),
        exchangeRegionCorrection: async () => {
          throw new Error('database unavailable')
        }
      } as never,
      drain: vi.fn(),
      ready: async () => true
    })
    const response = await app.request(
      '/v1/assign',
      assignmentRequest('abcdefghijklmnop', {
        preferredRegion: 'asia-east2',
        regionCorrection: { v: 1, action: 'issue-window' }
      })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      cellUrl: 'https://asia-c1.relay.example.test',
      assignmentEpoch: 7
    })
  })

  it('does not place or write a legacy hint when reporting migration evidence', async () => {
    const current = {
      userId: 'user-1',
      relayHostId: 'abcdefghijklmnop',
      cellId: 'asia-c1',
      cellUrl: 'https://asia-c1.relay.example.test',
      region: 'asia-east2',
      assignmentEpoch: 7,
      leaseExpiresAt: Date.now() + 300_000
    }
    const assign = vi.fn()
    const resolve = vi.fn(async () => current)
    const exchangeRegionCorrection = vi.fn(async () => ({ v: 1, reportStatus: 'accepted' }))
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: { assign, resolve, exchangeRegionCorrection } as never,
      drain: vi.fn(),
      ready: async () => true
    })
    const regionCorrection = {
      v: 1,
      action: 'report',
      generation: 2,
      assignmentEpoch: 7,
      policyVersion: 1,
      outcome: 'conclusive',
      measurements: { 'us-central1': 40, 'asia-east2': 180 }
    }
    const response = await app.request(
      '/v1/assign',
      assignmentRequest('abcdefghijklmnop', {
        preferredRegion: 'us-central1',
        regionCorrection
      })
    )
    expect(response.status).toBe(200)
    expect(assign).not.toHaveBeenCalled()
    expect(exchangeRegionCorrection).toHaveBeenCalledWith(
      { userId: 'user-1', relayHostId: 'abcdefghijklmnop' },
      regionCorrection,
      7
    )
    expect(((await response.json()) as { assignmentEpoch: number }).assignmentEpoch).toBe(7)
  })

  it('does not manufacture an assignment for a report whose assignment disappeared', async () => {
    const assign = vi.fn()
    const exchangeRegionCorrection = vi.fn()
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: { assign, resolve: async () => null, exchangeRegionCorrection } as never,
      drain: vi.fn(),
      ready: async () => true
    })
    const response = await app.request(
      '/v1/assign',
      assignmentRequest('abcdefghijklmnop', {
        regionCorrection: {
          v: 1,
          action: 'report',
          generation: 2,
          assignmentEpoch: 7,
          policyVersion: 1,
          outcome: 'inconclusive',
          reason: 'timeout'
        }
      })
    )
    expect(response.status).toBe(409)
    expect(assign).not.toHaveBeenCalled()
    expect(exchangeRegionCorrection).not.toHaveBeenCalled()
  })

  it('answers a pool that cannot hand out a client with a retryable 503', async () => {
    const regionCatalog = vi.fn(async () => {
      throw new Error('Connection terminated due to connection timeout')
    })
    const app = createRelayApp(config({ publicAssignmentRetryAfterSeconds: 7 }), {
      store: {} as never,
      assignments: { regionCatalog } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })

    const response = await app.request('/v1/regions')

    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('7')
    expect(await response.json()).toEqual({ error: 'region_catalog_temporarily_unavailable' })
  })

})

function assignmentRequest(relayHostId: string, extra: Record<string, unknown>): RequestInit {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${relayHostId}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ v: 1, relayHostId, ...extra })
  }
}

function config(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    port: 8080,
    publicUrl: 'https://relay.example.test',
    cellUrl: 'https://relay.example.test',
    region: 'us-central1',
    authIssuer: 'https://auth.example.test',
    authAudience: 'orca-relay',
    jwksUrl: 'https://auth.example.test/jwks',
    assignmentSigningKey: new TextEncoder().encode('assignment-key-with-at-least-32-bytes'),
    role: 'director',
    cellId: 'director',
    cells: [],
    adminAudience: 'https://relay.example.test/v1/admin/drain',
    deployServiceAccount: 'deploy@example.test',
    runtimeServiceAccount: 'runtime@example.test',
    adminJwksUrl: 'https://auth.example.test/jwks',
    databasePoolMax: 3,
    publicAssignmentsEnabled: true,
    regionalPlacementEnabled: true,
    publicAssignmentConcurrency: 2,
    publicAssignmentQueueMax: 128,
    publicAssignmentWaitMs: 4_000,
    publicResolveConcurrency: 1,
    publicResolveWaitMs: 5_000,
    publicAssignmentRetryAfterSeconds: 5,
    dataDir: './data',
    ...overrides
  }
}
