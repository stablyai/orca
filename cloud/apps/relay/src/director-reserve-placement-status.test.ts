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

// The deploy guard reads a director's placement here, so it must be what the director does.
describe('a director reports its reserve placement as built', () => {
  const status = async (operations: Record<string, unknown>, overrides: Partial<RelayConfig> = {}) => {
    const app = createRelayApp(config(overrides), {
      store: {} as never,
      assignments: {} as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true),
      ...operations
    })
    const response = await app.request('/v1/admin/runtime-status', {
      method: 'POST',
      headers: { authorization: 'Bearer deploy-token', 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1 })
    })
    return (await response.json()) as Record<string, unknown>
  }

  it('says off when placement is configured on but was never built', async () => {
    expect(await status({}, { reservePlacement: 'on' })).toMatchObject({ role: 'director', reservePlacement: 'off' })
  })

  it('says what the built placement does', async () => {
    expect(await status({ reservePlacement: { placementMode: 'on' } }, { reservePlacement: 'on' })).toMatchObject({
      reservePlacement: 'on'
    })
  })

  it('reports nothing for a cell', async () => {
    expect(await status({}, { role: 'cell', cellId: 'production-gce-c1' })).not.toHaveProperty('reservePlacement')
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
