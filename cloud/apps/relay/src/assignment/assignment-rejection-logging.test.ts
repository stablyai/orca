import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RelayAssignment } from './assignment-store.js'
import type { RelayConfig } from '../config.js'

const fakes = vi.hoisted(() => ({
  verifyRelayToken: vi.fn(async (token: string) => ({
    sub: 'user-1',
    relayHostId: token
  }))
}))

vi.mock('../authentication/relay-token-verifier.js', () => ({
  createRelayTokenVerifier: () => fakes.verifyRelayToken,
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

import { createRelayApp } from '../app.js'

describe('assignment rejection logging', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs the store reason and host digest when assign() rejects on capacity', async () => {
    const host = 'hhhhhhhhhhhhhhhh'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: {
        assign: vi.fn(async () => {
          throw new Error('relay_capacity_exhausted')
        }),
        resolve: vi.fn(async () => assignment('cell-r', host))
      } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })

    const hinted = await app.request('/v1/assign', assignmentRequest(host, { reconnect: true }))

    expect(hinted.status).toBe(503)
    expect(await hinted.json()).toEqual({ error: 'relay_capacity_exhausted' })
    const line = warn.mock.calls
      .map((call) => String(call[0]))
      .find((entry) => entry.includes('assignment rejected'))
    expect(line).toContain('route=assign')
    expect(line).toContain('lane=sticky')
    expect(line).toContain('hinted=true')
    expect(line).toContain('reason=relay_capacity_exhausted')
    expect(line).toContain('host=af342ad00ee4')
    expect(line).not.toContain(host)
  })
})

function assignmentRequest(
  relayHostId: string,
  extra: Record<string, unknown> = {}
): RequestInit & { headers: Record<string, string> } {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${relayHostId}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ v: 1, relayHostId, ...extra })
  }
}

function assignment(cellId: string, relayHostId: string): RelayAssignment {
  return {
    userId: 'user-1',
    relayHostId,
    cellId,
    cellUrl: `https://${cellId}.relay.example.test`,
    assignmentEpoch: 1,
    leaseExpiresAt: Date.now() + 300_000
  }
}

function config(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    port: 8080,
    publicUrl: 'https://relay.example.test',
    cellUrl: 'https://relay.example.test',
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
