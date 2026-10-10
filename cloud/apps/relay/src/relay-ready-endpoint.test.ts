import { describe, expect, it, vi } from 'vitest'
import { createRelayApp } from './app.js'
import type { RelayConfig } from './config.js'
import type { RelayReadinessDependency } from './relay-readiness.js'

function readyApp(input: { ready: boolean; degraded?: RelayReadinessDependency[] }) {
  // SAFETY: /ready reads only ready and readinessDegradation, so the rest of the surface, which
  // every other app route test also stubs this way, stays unbuilt.
  const operations = {
    store: {} as never,
    assignments: {} as never,
    drain: vi.fn(),
    ready: vi.fn(async () => input.ready),
    readinessDegradation: () => input.degraded ?? []
  } as Parameters<typeof createRelayApp>[1]
  return createRelayApp(config(), operations)
}

describe('relay readiness endpoint', () => {
  it('answers a healthy cell with the unchanged body', async () => {
    const response = await readyApp({ ready: true }).request('/ready')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('keeps the 200 the load balancer needs but marks a remembered answer', async () => {
    const response = await readyApp({ ready: true, degraded: ['sql'] }).request('/ready')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, degraded: true, dependency: ['sql'] })
  })

  it('still fails the cell out of rotation once no window covers the failure', async () => {
    const response = await readyApp({ ready: false }).request('/ready')

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'dependency_unavailable' })
  })
})

function config(): RelayConfig {
  return {
    port: 8080,
    publicUrl: 'https://c7.relay.example.test',
    cellUrl: 'https://c7.relay.example.test',
    region: 'us-central1',
    authIssuer: 'https://auth.example.test',
    authAudience: 'orca-relay',
    jwksUrl: 'https://auth.example.test/jwks',
    assignmentSigningKey: new Uint8Array(32),
    role: 'cell',
    cellId: 'production-gce-c7',
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
    dataDir: './data'
  }
}
