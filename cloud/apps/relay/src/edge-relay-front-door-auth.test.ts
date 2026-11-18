import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RELAY_HOST_CAPABILITIES_HEADER,
  RELAY_HOST_CAPABILITY_FRONT_DOOR_AUTH,
  RELAY_HOST_CAPABILITY_ORIGIN_ALTERNATES
} from '@orca-cloud/relay-contract'
import type { RelayConfig } from './config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'
import { parseEdgeControl, parseEdgeControlOver, type EdgeControlFlags } from './edge-relay-control.js'
import { EDGE_CELL_ID, EdgeAssignments, type EdgeRelayConfig } from './edge-relay.js'
import { edgeAuthOrigin } from './edge-relay-route.js'
// The strict answer parser shipped desktops carry.
import { AssignmentResponseSchema as ShippedAssignmentResponseSchema } from './test-fixtures/relay-contract-baseline/director-messages.js'

const fakes = vi.hoisted(() => ({
  verifyRelayToken: vi.fn(async (token: string) => ({ sub: 'user-1', relayHostId: token }))
}))

vi.mock('./relay-token-verifier.js', () => ({
  createRelayTokenVerifier: () => fakes.verifyRelayToken,
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

import { createRelayApp } from './app.js'

const EDGE_URL = 'https://edge.relay.example.test'
const DOOR = 'https://cn.relay.example.test'
const GCE_URL = 'https://us-c1.relay.example.test'
const COHORT_HOST = 'edgecohorthost01'
const LISTED_HOST = 'frontdoorhost001'
const OTHER_HOST = 'gcehostnotinedge'
const CAPABLE = { [RELAY_HOST_CAPABILITIES_HEADER]: `pending-conn-details, ${RELAY_HOST_CAPABILITY_FRONT_DOOR_AUTH}` }
const ALTERNATES_ONLY = { [RELAY_HOST_CAPABILITIES_HEADER]: RELAY_HOST_CAPABILITY_ORIGIN_ALTERNATES }

const databases: RelayDatabase[] = []
afterEach(async () => {
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
    publicAssignmentRetryAfterSeconds: 5,
    dataDir: './data'
  }
}

// frontDoorUrls null: ORCA_RELAY_EDGE_FRONT_DOOR_URLS unset.
async function harness(flags: { current: EdgeControlFlags }, frontDoorUrls: ReadonlySet<string> | null = new Set([DOOR])) {
  const database = await openInMemoryRelayDatabase()
  databases.push(database)
  const edgeConfig: EdgeRelayConfig = {
    cellUrl: EDGE_URL,
    rolloutPercent: 0,
    allowHosts: new Set([COHORT_HOST]),
    denyHosts: new Set(),
    regions: new Set(['us-central1']),
    control: () => flags.current,
    ...(frontDoorUrls ? { frontDoorUrls } : {})
  }
  const edge = new EdgeAssignments(database, edgeConfig)
  await edge.ensureEdgeCell()
  const gce = {
    userId: 'user-1',
    cellId: 'us-c1',
    cellUrl: GCE_URL,
    region: 'us-central1' as const,
    assignmentEpoch: 3,
    leaseExpiresAt: Date.now() + 90_000
  }
  const app = createRelayApp(config(), {
    store: { resolveResume: vi.fn(async () => ({ userId: 'user-1' })) } as never,
    assignments: {
      assign: vi.fn(async (identity: { relayHostId: string }) => ({ ...gce, relayHostId: identity.relayHostId })),
      resolve: vi.fn(async () => null),
      exchangeRegionCorrection: vi.fn()
    } as never,
    reservePlacement: { plan: vi.fn(async () => ({ kind: 'database' })), raiseEpochFloor: vi.fn(), rowEpochFloor: () => 0 } as never,
    edgeAssignments: edge,
    drain: vi.fn(),
    ready: vi.fn(async () => true)
  })
  const assign = async (relayHostId: string, headers: Record<string, string> = {}) => {
    const response = await app.request('/v1/assign', {
      method: 'POST',
      headers: { authorization: `Bearer ${relayHostId}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ v: 1, relayHostId, preferredRegion: 'us-central1' })
    })
    expect(response.status).toBe(200)
    return (await response.json()) as Record<string, unknown>
  }
  return { assign }
}

const shape = (body: Record<string, unknown>) => Object.keys(body).sort()
const PLAIN = ['assignmentEpoch', 'cellUrl', 'lease', 'v']

describe('director/edge.json frontDoorAuth', () => {
  const parse = (flags: unknown) => parseEdgeControl({ v: 1, flags })

  it('parses each value; absent leaves no key', () => {
    for (const frontDoorAuth of ['off', 'on'] as const) {
      expect(parse({ frontDoorAuth })?.flags).toEqual({ mode: 'on', frontDoorAuth })
    }
    expect(parse({ mode: 'on' })).toEqual({ flags: { mode: 'on' }, ignoredKeys: [] })
  })

  it('a bad value drops only this key (reported) and keeps the last applied one', () => {
    for (const frontDoorAuth of ['listed', true, 1, null, ['on'], { mode: 'on' }]) {
      expect(parse({ mode: 'off', rolloutPermille: 5, frontDoorAuth })).toEqual({
        flags: { mode: 'off', rolloutPermille: 5 },
        ignoredKeys: ['frontDoorAuth']
      })
      expect(parseEdgeControlOver({ v: 1, flags: { mode: 'on', frontDoorAuth } }, { mode: 'on', frontDoorAuth: 'on' })).toEqual({
        flags: { mode: 'on', frontDoorAuth: 'on' },
        ignoredKeys: ['frontDoorAuth']
      })
    }
    expect(parseEdgeControlOver({ v: 1, flags: { mode: 'on' } }, { mode: 'on', frontDoorAuth: 'on' })).toEqual({
      flags: { mode: 'on' },
      ignoredKeys: []
    })
  })
})

describe('edgeAuthOrigin', () => {
  const edgeConfig = (flags: EdgeControlFlags, frontDoorUrls: ReadonlySet<string> | null = new Set([DOOR])): EdgeRelayConfig => ({
    cellUrl: EDGE_URL,
    rolloutPercent: 0,
    allowHosts: new Set(),
    denyHosts: new Set(),
    regions: new Set(['us-central1']),
    control: () => flags,
    ...(frontDoorUrls ? { frontDoorUrls } : {})
  })
  const on: EdgeControlFlags = { mode: 'on', frontDoorAuth: 'on', frontDoor: { url: DOOR, countries: ['CN'] } }

  it('an edge answer through an allowed front door: that front door', () => {
    expect(edgeAuthOrigin(edgeConfig(on), { cellId: EDGE_CELL_ID, cellUrl: DOOR })).toBe(DOOR)
  })

  it('none for a direct edge answer, a GCE cell, or a door outside ORCA_RELAY_EDGE_FRONT_DOOR_URLS', () => {
    expect(edgeAuthOrigin(edgeConfig(on), { cellId: EDGE_CELL_ID, cellUrl: EDGE_URL })).toBeUndefined()
    expect(edgeAuthOrigin(edgeConfig(on), { cellId: 'us-c1', cellUrl: DOOR })).toBeUndefined()
    expect(edgeAuthOrigin(edgeConfig(on, null), { cellId: EDGE_CELL_ID, cellUrl: DOOR })).toBeUndefined()
    expect(
      edgeAuthOrigin(edgeConfig(on, new Set(['https://other.relay.example.test'])), { cellId: EDGE_CELL_ID, cellUrl: DOOR })
    ).toBeUndefined()
  })

  it('none with the flag off or absent', () => {
    expect(edgeAuthOrigin(edgeConfig({ ...on, frontDoorAuth: 'off' }), { cellId: EDGE_CELL_ID, cellUrl: DOOR })).toBeUndefined()
    const { frontDoorAuth: _, ...absent } = on
    expect(edgeAuthOrigin(edgeConfig(absent), { cellId: EDGE_CELL_ID, cellUrl: DOOR })).toBeUndefined()
  })
})

describe('POST /v1/assign authOrigin', () => {
  // A listed host is answered through the front door; an allow-listed host with no mapping on the edge URL.
  const doorFlags = (frontDoorAuth?: EdgeControlFlags['frontDoorAuth']): EdgeControlFlags => ({
    mode: 'on',
    frontDoor: { url: DOOR, hosts: [LISTED_HOST] },
    ...(frontDoorAuth ? { frontDoorAuth } : {})
  })

  it('without the capability header: no field, and the answer parses under the shipped strict schema', async () => {
    const h = await harness({ current: doorFlags('on') })
    const body = await h.assign(LISTED_HOST)
    expect(body).toMatchObject({ cellUrl: DOOR })
    expect(shape(body)).toEqual(PLAIN)
    expect(ShippedAssignmentResponseSchema.safeParse(body).success).toBe(true)
  })

  it('with only the alternates capability: no authOrigin', async () => {
    const h = await harness({ current: doorFlags('on') })
    const body = await h.assign(LISTED_HOST, ALTERNATES_ONLY)
    expect(body).toMatchObject({ cellUrl: DOOR })
    expect(body).not.toHaveProperty('authOrigin')
  })

  it('with the header but the flag off or absent: no field', async () => {
    for (const frontDoorAuth of [undefined, 'off'] as const) {
      const h = await harness({ current: doorFlags(frontDoorAuth) })
      const body = await h.assign(LISTED_HOST, CAPABLE)
      expect(body).toMatchObject({ cellUrl: DOOR })
      expect(shape(body)).toEqual(PLAIN)
    }
  })

  it('header and flag on: a host answered through the front door gets it as authOrigin', async () => {
    const h = await harness({ current: doorFlags('on') })
    const body = await h.assign(LISTED_HOST, CAPABLE)
    expect(body).toMatchObject({ v: 1, cellUrl: DOOR, authOrigin: DOOR })
    expect(shape(body)).toEqual(['assignmentEpoch', 'authOrigin', 'cellUrl', 'lease', 'v'])
    expect(ShippedAssignmentResponseSchema.safeParse(body).success).toBe(false)
    // A re-ask (the sticky keep) answers the same.
    expect(await h.assign(LISTED_HOST, CAPABLE)).toMatchObject({ cellUrl: DOOR, authOrigin: DOOR })
  })

  it('header and flag on: a direct edge host and a GCE host get none', async () => {
    const h = await harness({ current: doorFlags('on') })
    const edgeBody = await h.assign(COHORT_HOST, CAPABLE)
    expect(edgeBody).toMatchObject({ cellUrl: EDGE_URL })
    expect(shape(edgeBody)).toEqual(PLAIN)
    const gceBody = await h.assign(OTHER_HOST, CAPABLE)
    expect(gceBody).toMatchObject({ cellUrl: GCE_URL })
    expect(shape(gceBody)).toEqual(PLAIN)
  })

  it('without ORCA_RELAY_EDGE_FRONT_DOOR_URLS: none, whatever the flags say', async () => {
    const h = await harness({ current: doorFlags('on') }, null)
    const body = await h.assign(LISTED_HOST, CAPABLE)
    expect(shape(body)).toEqual(PLAIN)
  })
})
