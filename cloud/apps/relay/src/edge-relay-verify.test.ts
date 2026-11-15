import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RelayConfig } from './config.js'
import { hashCredential } from './credential-store.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'
import {
  EdgeAdminUnavailableError,
  type EdgeAdmin,
  type EdgeAssignBody,
  type EdgeVerifyBody,
  type EdgeVerifyResult
} from './edge-admin-client.js'
import { EDGE_VERIFY_NEGATIVE_TTL_MS, EdgeAssignments, type EdgeRelayConfig } from './edge-relay.js'

const fakes = vi.hoisted(() => ({
  verifyRelayToken: vi.fn(async (token: string) => ({ sub: 'user-1', relayHostId: token }))
}))

vi.mock('./relay-token-verifier.js', () => ({
  createRelayTokenVerifier: () => fakes.verifyRelayToken,
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

import { createRelayApp } from './app.js'

const EDGE_URL = 'https://edge.relay.example.test'
const HOST = 'edgecohorthost01'
const OTHER_HOST = 'gcecellhost00001'
const USER = 'user-1'
// Resume tokens are 32 random bytes, base64url (ResolveRequestSchema).
const GOOD = 'A'.repeat(43)
const BAD = 'B'.repeat(43)

const databases: RelayDatabase[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const database of databases.splice(0)) { await database.close() }
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
    // No per-host spacing: each test re-asks the same host within milliseconds.
    publicAssignmentRetryAfterSeconds: 0,
    dataDir: './data'
  }
}

// The edge's verify rules (relay-edge HostRelay.adminVerify): a credential paired on the edge,
// answered only while the object holds the host.
class FakeEdge implements EdgeAdmin {
  verifies: EdgeVerifyBody[] = []
  mode: 'ok' | 'old' | 'down' | 'not_here' | 'foreign' = 'ok'

  async assign(body: EdgeAssignBody) {
    return { outcome: 'applied' as const, assignmentEpoch: body.assignmentEpoch }
  }

  async exportHost() {
    return { outcome: 'exported' as const, assignment: null, devices: [] }
  }

  async drain() {
    return { outcome: 'idle' as const }
  }

  async verify(body: EdgeVerifyBody): Promise<EdgeVerifyResult> {
    this.verifies.push(body)
    // An edge from before the op answers 404, which the client throws as unavailable.
    if (this.mode === 'old') { throw new EdgeAdminUnavailableError('status_404') }
    if (this.mode === 'down') { throw new EdgeAdminUnavailableError('network') }
    if (this.mode === 'not_here') { return { outcome: 'not_here' } }
    if (body.tokenHash !== hashCredential(GOOD)) { return { outcome: 'none' } }
    const userId = this.mode === 'foreign' ? 'user-2' : USER
    return { outcome: 'verified', userId, relayDeviceId: 'phone-edge', assignmentEpoch: 1 }
  }
}

async function harness(options: { admin?: EdgeAdmin } = {}) {
  const database = await openInMemoryRelayDatabase()
  databases.push(database)
  const edgeConfig: EdgeRelayConfig = {
    cellUrl: EDGE_URL,
    rolloutPercent: 0,
    allowHosts: new Set([HOST]),
    allowUsers: new Set(),
    denyHosts: new Set(),
    regions: new Set(['us-central1', 'asia-east2'])
  }
  const fake = new FakeEdge()
  const clock = { now: Date.now() }
  const edge = new EdgeAssignments(database, edgeConfig, () => clock.now, 'admin' in options ? options.admin : fake)
  await edge.ensureEdgeCell()
  const gce = {
    userId: USER,
    cellId: 'us-c1',
    cellUrl: 'https://us-c1.relay.example.test',
    region: 'us-central1' as const,
    assignmentEpoch: 9,
    leaseExpiresAt: Date.now() + 90_000
  }
  const assignments = {
    assign: vi.fn(async (identity: { relayHostId: string }) => ({ ...gce, relayHostId: identity.relayHostId })),
    resolve: vi.fn(async () => null),
    exchangeRegionCorrection: vi.fn()
  }
  // Postgres knows no phone of the host: every credential here was paired on the edge.
  const store = { resolveResume: vi.fn(async () => null) }
  const app = createRelayApp(config(), {
    store: store as never,
    assignments: assignments as never,
    reservePlacement: { plan: vi.fn(async () => ({ kind: 'database' })), raiseEpochFloor: vi.fn(), rowEpochFloor: () => 0 } as never,
    edgeAssignments: edge,
    drain: vi.fn(),
    ready: vi.fn(async () => true)
  })
  const assign = async (relayHostId = HOST) =>
    await app.request('/v1/assign', {
      method: 'POST',
      headers: { authorization: `Bearer ${relayHostId}`, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, relayHostId, preferredRegion: 'us-central1' })
    })
  const resolve = async (resumeToken: string, relayHostId = HOST) =>
    await app.request('/v1/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, relayHostId, resumeToken })
    })
  return { database, fake, clock, edge, assignments, assign, resolve }
}

describe('phone credentials that only the edge holds', () => {
  it('resolves a phone paired on the edge to the edge, asking with the hash, never the token', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await harness()
    expect((await h.assign()).status).toBe(200)
    const response = await h.resolve(GOOD)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ v: 1, cellUrl: EDGE_URL, assignmentEpoch: 1 })
    expect(h.fake.verifies).toEqual([{ relayHostId: HOST, kind: 'resume', tokenHash: hashCredential(GOOD) }])
    expect(JSON.stringify(h.fake.verifies)).not.toContain(GOOD)
    // Read-only on the director too: no new placement.
    expect(h.assignments.assign).not.toHaveBeenCalled()
  })

  it('still 401s a token the edge does not know, and answers its retries from memory', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await harness()
    await h.assign()
    expect((await h.resolve(BAD)).status).toBe(401)
    expect((await h.resolve(BAD)).status).toBe(401)
    expect(h.fake.verifies).toHaveLength(1)
    // The refusal lapses, so a credential that later becomes valid is asked about again.
    h.clock.now += EDGE_VERIFY_NEGATIVE_TTL_MS + 1
    expect((await h.resolve(BAD)).status).toBe(401)
    expect(h.fake.verifies).toHaveLength(2)
  })

  it('401s, as before, when the edge has no verify op or is unreachable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await harness()
    await h.assign()
    h.fake.mode = 'old'
    expect((await h.resolve(GOOD)).status).toBe(401)
    h.fake.mode = 'down'
    expect((await h.resolve(GOOD)).status).toBe(401)
    expect(warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('orca_relay_edge_verify_unavailable'))).toHaveLength(2)
  })

  it('401s with an admin client that has no verify at all (a director-side fake or older client)', async () => {
    const admin: EdgeAdmin = {
      assign: async (body) => ({ outcome: 'applied', assignmentEpoch: body.assignmentEpoch }),
      exportHost: async () => ({ outcome: 'exported', assignment: null, devices: [] }),
      drain: async () => ({ outcome: 'idle' })
    }
    const h = await harness({ admin })
    await h.assign()
    expect((await h.resolve(GOOD)).status).toBe(401)
  })

  it('never asks the edge about a host whose row is not on the edge', async () => {
    const h = await harness()
    expect((await h.resolve(GOOD, OTHER_HOST)).status).toBe(401)
    expect(h.fake.verifies).toHaveLength(0)
  })

  it('401s when the edge no longer holds the host, or answers for another account', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await harness()
    await h.assign()
    h.fake.mode = 'not_here'
    expect((await h.resolve(GOOD)).status).toBe(401)
    h.clock.now += EDGE_VERIFY_NEGATIVE_TTL_MS + 1
    h.fake.mode = 'foreign'
    expect((await h.resolve(GOOD)).status).toBe(401)
  })

  it('answers an invite created on the edge for the director invite move', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await harness()
    await h.assign()
    const verified = await h.edge.verifyOnEdge(HOST, 'invite', GOOD)
    expect(verified).toMatchObject({ identity: { userId: USER, relayHostId: HOST }, assignment: { cellUrl: EDGE_URL } })
    expect(h.fake.verifies.at(-1)).toEqual({ relayHostId: HOST, kind: 'invite', tokenHash: hashCredential(GOOD) })
    expect(await h.edge.verifyOnEdge(HOST, 'invite', BAD)).toBeNull()
  })
})
