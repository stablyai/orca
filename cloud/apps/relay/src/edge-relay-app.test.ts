import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RelayConfig } from './config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'
import { EdgeAssignments, type EdgeRelayConfig } from './edge-relay.js'

const fakes = vi.hoisted(() => ({
  verifyRelayToken: vi.fn(async (token: string) => ({ sub: 'user-1', relayHostId: token }))
}))

vi.mock('./relay-token-verifier.js', () => ({
  createRelayTokenVerifier: () => fakes.verifyRelayToken,
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

import { createRelayApp } from './app.js'

const EDGE_URL = 'https://edge.relay.example.test'
const COHORT_HOST = 'edgecohorthost01'
const OTHER_HOST = 'gcehostnotinedge'

const databases: RelayDatabase[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) await database.close()
})

function config(): RelayConfig {
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
    dataDir: './data'
  }
}

async function harness(options: { seeded?: boolean } = {}) {
  const database = await openInMemoryRelayDatabase()
  databases.push(database)
  const edgeConfig: EdgeRelayConfig = {
    cellUrl: EDGE_URL,
    rolloutPercent: 0,
    allowHosts: new Set([COHORT_HOST]),
    denyHosts: new Set(),
    regions: new Set(['us-central1'])
  }
  const edge = new EdgeAssignments(database, edgeConfig)
  if (options.seeded !== false) await edge.ensureEdgeCell()
  const gce = {
    userId: 'user-1',
    cellId: 'us-c1',
    cellUrl: 'https://us-c1.relay.example.test',
    region: 'us-central1' as const,
    assignmentEpoch: 3,
    leaseExpiresAt: Date.now() + 90_000
  }
  const assignments = {
    assign: vi.fn(async (identity: { relayHostId: string }) => ({ ...gce, relayHostId: identity.relayHostId })),
    resolve: vi.fn(async () => null),
    exchangeRegionCorrection: vi.fn()
  }
  const plan = vi.fn(async () => ({ kind: 'database' }))
  const raiseEpochFloor = vi.fn()
  const store = { resolveResume: vi.fn(async () => ({ userId: 'user-1' })) }
  const app = createRelayApp(config(), {
    store: store as never,
    assignments: assignments as never,
    reservePlacement: { plan, raiseEpochFloor, rowEpochFloor: () => 0 } as never,
    edgeAssignments: edge,
    drain: vi.fn(),
    ready: vi.fn(async () => true)
  })
  const assign = async (relayHostId: string, extra: Record<string, unknown> = {}) =>
    await app.request('/v1/assign', {
      method: 'POST',
      headers: { authorization: `Bearer ${relayHostId}`, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, relayHostId, preferredRegion: 'us-central1', ...extra })
    })
  const resolve = async (relayHostId: string) =>
    await app.request('/v1/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, relayHostId, resumeToken: 'r'.repeat(43) })
    })
  return { database, edge, assignments, plan, raiseEpochFloor, assign, resolve }
}

describe('director routes with the relay edge', () => {
  it('answers a cohort host on the edge before any other lane, with the exact wire shape', async () => {
    const h = await harness()
    const response = await h.assign(COHORT_HOST, { reconnect: true })
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['assignmentEpoch', 'cellUrl', 'lease', 'v'])
    expect(body).toMatchObject({ v: 1, cellUrl: EDGE_URL, assignmentEpoch: 1 })
    expect(h.plan).not.toHaveBeenCalled()
    expect(h.assignments.assign).not.toHaveBeenCalled()
    expect(h.assignments.resolve).not.toHaveBeenCalled()
    expect(h.raiseEpochFloor).toHaveBeenCalledWith({ userId: 'user-1', relayHostId: COHORT_HOST }, 1)
    // A re-ask keeps the epoch.
    expect(await (await h.assign(COHORT_HOST)).json()).toMatchObject({ assignmentEpoch: 1 })
  })

  it('keeps today\'s path for hosts outside the cohort', async () => {
    const h = await harness()
    const response = await h.assign(OTHER_HOST)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ cellUrl: 'https://us-c1.relay.example.test' })
    expect(h.plan).toHaveBeenCalled()
    expect(h.assignments.assign).toHaveBeenCalled()
  })

  it('keeps today\'s path for everyone until the edge cell is seeded', async () => {
    const h = await harness({ seeded: false })
    const response = await h.assign(COHORT_HOST)
    expect(await response.json()).toMatchObject({ cellUrl: 'https://us-c1.relay.example.test' })
  })

  it('keeps a host still holding units on its old cell there (no 503), moving it on a later ask', async () => {
    const h = await harness()
    await h.database.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at, last_activity_at,
        reserved_controls, reserved_splices, reserved_invites, pending_installs,
        pending_confirmations, migration_leases)
       VALUES ('user-1', ?, 'us-c1', 5, 0, 0, 1, 0, 0, 0, 0, 0)`,
      [COHORT_HOST]
    )
    const response = await h.assign(COHORT_HOST)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ cellUrl: 'https://us-c1.relay.example.test' })
    expect(h.assignments.assign).toHaveBeenCalled()
  })

  it('answers a phone /v1/resolve for an edge host from the edge row, with the exact wire shape', async () => {
    const h = await harness()
    await h.assign(COHORT_HOST)
    const response = await h.resolve(COHORT_HOST)
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['assignmentEpoch', 'cellUrl', 'leaseExpiresAt', 'v'])
    expect(body).toMatchObject({ v: 1, cellUrl: EDGE_URL, assignmentEpoch: 1 })
    expect(h.assignments.resolve).not.toHaveBeenCalled()
    expect(h.assignments.assign).not.toHaveBeenCalled()
  })

  it('never moves a host on a phone resolve', async () => {
    const h = await harness()
    const response = await h.resolve(COHORT_HOST)
    expect(await response.json()).toMatchObject({ cellUrl: 'https://us-c1.relay.example.test' })
    expect(await h.edge.edgeAssignment({ userId: 'user-1', relayHostId: COHORT_HOST })).toBeNull()
  })
})
