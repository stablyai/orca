import { describe, expect, it, vi } from 'vitest'
import type { RelayConfig } from './config.js'

const fakes = vi.hoisted(() => ({
  verifyRelayToken: vi.fn(async (token: string) => ({ sub: 'user-1', relayHostId: token }))
}))

vi.mock('./relay-token-verifier.js', () => ({
  createRelayTokenVerifier: () => fakes.verifyRelayToken,
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

import { createRelayApp } from './app.js'

describe('Relay region API', () => {
  it('passes a valid preference to placement and records coarse outcomes', async () => {
    const assign = vi.fn(async () => ({
      userId: 'user-1',
      relayHostId: 'asiahost00000001',
      cellId: 'asia-c1',
      cellUrl: 'https://asia-c1.relay.example.test',
      region: 'asia-east2' as const,
      assignmentEpoch: 1,
      leaseExpiresAt: Date.now() + 300_000
    }))
    const recordRegionRequest = vi.fn()
    const recordRegionSelection = vi.fn()
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: { assign, resolve: vi.fn(async () => null) } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true),
      recordRegionRequest,
      recordRegionSelection
    })

    const response = await app.request(
      '/v1/assign',
      assignmentRequest('asiahost00000001', { preferredRegion: 'asia-east2' })
    )

    expect(response.status).toBe(200)
    expect(await response.clone().json()).not.toHaveProperty('regionCorrection')
    expect(assign).toHaveBeenCalledWith(
      { userId: 'user-1', relayHostId: 'asiahost00000001' },
      'asia-east2',
      'asia-east2'
    )
    expect(recordRegionRequest).toHaveBeenCalledWith('asia-east2')
    expect(recordRegionSelection).toHaveBeenCalledWith({
      targetRegion: 'asia-east2',
      selectedRegion: 'asia-east2',
      fallback: false
    })
  })

  it('keeps the preference for observation while the kill switch places US-first', async () => {
    const assign = vi.fn(async () => ({
      userId: 'user-1',
      relayHostId: 'killhost00000001',
      cellId: 'us-c1',
      cellUrl: 'https://us-c1.relay.example.test',
      region: 'us-central1' as const,
      assignmentEpoch: 1,
      leaseExpiresAt: Date.now() + 300_000
    }))
    const app = createRelayApp(config({ regionalPlacementEnabled: false }), {
      store: {} as never,
      assignments: { assign, resolve: vi.fn(async () => null) } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })

    const response = await app.request(
      '/v1/assign',
      assignmentRequest('killhost00000001', { preferredRegion: 'asia-east2' })
    )

    expect(response.status).toBe(200)
    expect(assign).toHaveBeenCalledWith(
      { userId: 'user-1', relayHostId: 'killhost00000001' },
      'asia-east2',
      'us-central1'
    )
  })

  it('preserves the cold-start hint and binds a negotiated window after placement', async () => {
    const assignment = {
      userId: 'user-1',
      relayHostId: 'abcdefghijklmnop',
      cellId: 'asia-c1',
      cellUrl: 'https://asia-c1.relay.example.test',
      region: 'asia-east2',
      assignmentEpoch: 7,
      leaseExpiresAt: Date.now() + 300_000
    }
    const assign = vi.fn(async () => assignment)
    const window = {
      generation: 2,
      expiresAt: Date.now() + 86_400_000,
      assignmentEpoch: 7,
      incumbentRegion: 'asia-east2',
      policyVersion: 1
    }
    const exchangeRegionCorrection = vi.fn(async () => ({ v: 1, window }))
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: { assign, exchangeRegionCorrection } as never,
      drain: vi.fn(),
      ready: async () => true
    })
    const regionCorrection = { v: 1, action: 'issue-window' }
    const response = await app.request(
      '/v1/assign',
      assignmentRequest('abcdefghijklmnop', {
        preferredRegion: 'asia-east2',
        regionCorrection
      })
    )
    expect(response.status).toBe(200)
    expect(assign).toHaveBeenCalledWith(
      { userId: 'user-1', relayHostId: 'abcdefghijklmnop' },
      'asia-east2',
      'asia-east2'
    )
    expect(exchangeRegionCorrection).toHaveBeenCalledWith(
      { userId: 'user-1', relayHostId: 'abcdefghijklmnop' },
      regionCorrection,
      7
    )
    expect(((await response.json()) as { regionCorrection: unknown }).regionCorrection).toEqual({
      v: 1,
      window
    })
  })

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

  it('exposes only the store-provided healthy catalog from directors', async () => {
    const regionCatalog = vi.fn(async () => [
      { region: 'us-central1' as const, probeOrigins: ['https://us.relay.example.test'] }
    ])
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: { regionCatalog } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })

    const response = await app.request('/v1/regions')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      v: 1,
      regions: [
        { region: 'us-central1', probeOrigins: ['https://us.relay.example.test'] }
      ]
    })

    const burst = await Promise.all(
      Array.from({ length: 50 }, () => app.request('/v1/regions'))
    )
    expect(burst.every(({ status }) => status === 200)).toBe(true)
    expect(regionCatalog).toHaveBeenCalledOnce()
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
