import { describe, expect, it, vi } from 'vitest'
import type { RelayConfig } from './config.js'

vi.mock('./authentication/admin-token-verifier.js', () => ({
  createAdminTokenVerifier: () => async (token: string) => token === 'deploy-token',
  createReadOnlyAdminTokenVerifier: () => async () => false,
  createRegionalRehomeControlApplyTokenVerifier: () => async () => false,
  createRegionalRehomeRuntimeTokenVerifier: () => async () => false,
  createRegionalRehomeTokenVerifier: () => async () => false,
  createRuntimeTokenVerifier: () => async () => false
}))

vi.mock('./authentication/relay-token-verifier.js', () => ({
  createRelayTokenVerifier: () => async () => null,
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

import { createRelayApp } from './app.js'

// Actual pg-pool timeout shape that a rollout incorrectly surfaced as 404.
const poolTimeout = () => new Error('Connection terminated due to connection timeout')

function adminRequest(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer deploy-token', 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }
}

function appWith(assignments: Record<string, unknown>, overrides: Partial<RelayConfig> = {}) {
  return createRelayApp(config(overrides), {
    store: {} as never,
    assignments: assignments as never,
    drain: vi.fn(),
    ready: vi.fn(async () => true)
  })
}

describe('admin routes under a database that is briefly out of reach', () => {
  it('answers cell-status with a retryable 503 instead of a not-found', async () => {
    const cellDeploymentStatus = vi.fn(async () => {
      throw poolTimeout()
    })
    const app = appWith({ cellDeploymentStatus }, { publicAssignmentRetryAfterSeconds: 7 })

    const response = await app.request(
      '/v1/admin/cell-status',
      adminRequest({ v: 1, cellId: 'production-gce-c7' })
    )

    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('7')
    expect(await response.json()).toEqual({ error: 'database_temporarily_unavailable' })
  })
})

function config(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    port: 8080,
    publicUrl: 'https://relay.example.test',
    cellUrl: 'https://relay.example.test',
    region: 'us-central1',
    authIssuer: 'https://auth.example.test',
    authAudience: 'orca-relay',
    jwksUrl: 'https://auth.example.test/jwks',
    assignmentSigningKey: new Uint8Array(32),
    role: 'director',
    cellId: 'director',
    cells: [],
    adminAudience: 'https://relay.example.test/v1/admin/drain',
    deployServiceAccount: 'deploy@example.test',
    runtimeServiceAccount: 'relay-cell@example.test',
    adminJwksUrl: 'https://auth.example.test/jwks',
    databasePoolMax: 10,
    publicAssignmentsEnabled: true,
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
