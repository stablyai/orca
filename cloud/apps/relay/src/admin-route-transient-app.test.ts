import { describe, expect, it, vi } from 'vitest'
import type { RelayConfig } from './config.js'

vi.mock('./admin-token-verifier.js', () => ({
  createAdminTokenVerifier: () => async (token: string) => token === 'deploy-token',
  createReadOnlyAdminTokenVerifier: () => async () => false,
  createRegionalRehomeControlApplyTokenVerifier: () => async () => false,
  createRegionalRehomeRuntimeTokenVerifier: () => async () => false,
  createRegionalRehomeTokenVerifier: () => async () => false,
  createRuntimeTokenVerifier: () => async () => false
}))

vi.mock('./relay-token-verifier.js', () => ({
  createRelayTokenVerifier: () => async () => null,
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

import { createRelayApp } from './app.js'

// The message the pool raises when its own dial outruns connectionTimeoutMillis.
// This is the shape that failed a rollout wave as an HTTP 404.
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

  it('keeps the not-found mapping for a real cell-status failure', async () => {
    const cellDeploymentStatus = vi.fn(async () => {
      throw new Error('unknown_cell')
    })
    const app = appWith({ cellDeploymentStatus })

    const response = await app.request(
      '/v1/admin/cell-status',
      adminRequest({ v: 1, cellId: 'production-gce-c7' })
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'unknown_cell' })
  })

  it('answers admission-selector/status with a retryable 503 instead of a conflict', async () => {
    const inspectCellAdmissionSelector = vi.fn(async () => {
      throw poolTimeout()
    })
    const app = appWith({ inspectCellAdmissionSelector })

    const response = await app.request(
      '/v1/admin/admission-selector/status',
      adminRequest({ v: 1, attemptId: '22222222-2222-4222-8222-222222222222' })
    )

    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('5')
    expect(await response.json()).toEqual({ error: 'database_temporarily_unavailable' })
  })

  it('keeps the conflict mapping for a real admission-selector/status failure', async () => {
    const inspectCellAdmissionSelector = vi.fn(async () => {
      throw new Error('admission_selector_attempt_not_found')
    })
    const app = appWith({ inspectCellAdmissionSelector })

    const response = await app.request(
      '/v1/admin/admission-selector/status',
      adminRequest({ v: 1, attemptId: '22222222-2222-4222-8222-222222222222' })
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'admission_selector_attempt_not_found' })
  })

  it('leaves the pre-request guards ahead of the mapping alone', async () => {
    const cellDeploymentStatus = vi.fn(async () => {
      throw poolTimeout()
    })
    const app = appWith({ cellDeploymentStatus })

    // An unauthenticated caller must never learn the database is struggling.
    const unauthenticated = await app.request('/v1/admin/cell-status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, cellId: 'production-gce-c7' })
    })
    expect(unauthenticated.status).toBe(401)

    const invalid = await app.request('/v1/admin/cell-status', adminRequest({ v: 1 }))
    expect(invalid.status).toBe(400)
    expect(cellDeploymentStatus).not.toHaveBeenCalled()
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
