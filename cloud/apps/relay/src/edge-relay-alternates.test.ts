import { afterEach, describe, expect, it, vi } from 'vitest'
import { RELAY_HOST_CAPABILITIES_HEADER, RELAY_HOST_CAPABILITY_ORIGIN_ALTERNATES } from '@orca-cloud/relay-contract'
import type { RelayConfig } from './config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'
import { parseEdgeControl, parseEdgeControlOver, type EdgeControlFlags } from './edge-relay-control.js'
import { EDGE_CELL_ID, EdgeAssignments, type EdgeRelayConfig } from './edge-relay.js'
import { edgeAlternateCellUrls } from './edge-relay-route.js'
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
const CAPABLE = { [RELAY_HOST_CAPABILITIES_HEADER]: `pending-conn-details, ${RELAY_HOST_CAPABILITY_ORIGIN_ALTERNATES}` }

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

describe('director/edge.json alternates', () => {
  const parse = (flags: unknown) => parseEdgeControl({ v: 1, flags })

  it('parses each value; absent leaves no key', () => {
    for (const alternates of ['off', 'listed', 'country'] as const) {
      expect(parse({ alternates })?.flags).toEqual({ mode: 'on', alternates })
    }
    expect(parse({ mode: 'on' })).toEqual({ flags: { mode: 'on' }, ignoredKeys: [] })
  })

  it('a bad value drops only this key (reported) and keeps the last applied one', () => {
    for (const alternates of ['on', true, 1, null, ['listed'], { mode: 'listed' }]) {
      expect(parse({ mode: 'off', rolloutPermille: 5, alternates })).toEqual({
        flags: { mode: 'off', rolloutPermille: 5 },
        ignoredKeys: ['alternates']
      })
      expect(parseEdgeControlOver({ v: 1, flags: { mode: 'on', alternates } }, { mode: 'on', alternates: 'listed' })).toEqual({
        flags: { mode: 'on', alternates: 'listed' },
        ignoredKeys: ['alternates']
      })
    }
    // Removing the key is not a bad value: alternates stop.
    expect(parseEdgeControlOver({ v: 1, flags: { mode: 'on' } }, { mode: 'on', alternates: 'country' })).toEqual({
      flags: { mode: 'on' },
      ignoredKeys: []
    })
  })
})

describe('edgeAlternateCellUrls', () => {
  const edgeConfig = (flags: EdgeControlFlags, frontDoorUrls: ReadonlySet<string> | null = new Set([DOOR])): EdgeRelayConfig => ({
    cellUrl: EDGE_URL,
    rolloutPercent: 0,
    allowHosts: new Set(),
    denyHosts: new Set(),
    regions: new Set(['us-central1']),
    control: () => flags,
    ...(frontDoorUrls ? { frontDoorUrls } : {})
  })
  const onEdge = (cellUrl: string) => ({ cellId: EDGE_CELL_ID, cellUrl })
  const byCountry: EdgeControlFlags = { mode: 'on', alternates: 'country', frontDoor: { url: DOOR, countries: ['CN'] } }
  const byId: EdgeControlFlags = { mode: 'on', alternates: 'listed', frontDoor: { url: DOOR, hosts: [LISTED_HOST] } }

  it('direct edge answer with a mapped front door: the front door; front door answer: the edge URL', () => {
    expect(edgeAlternateCellUrls(edgeConfig(byCountry), COHORT_HOST, 'us-central1', 'CN', onEdge(EDGE_URL))).toEqual([DOOR])
    expect(edgeAlternateCellUrls(edgeConfig(byCountry), COHORT_HOST, 'us-central1', 'CN', onEdge(DOOR))).toEqual([EDGE_URL])
    expect(edgeAlternateCellUrls(edgeConfig(byId), LISTED_HOST, undefined, null, onEdge(EDGE_URL))).toEqual([DOOR])
    expect(edgeAlternateCellUrls(edgeConfig(byId), LISTED_HOST, undefined, null, onEdge(DOOR))).toEqual([EDGE_URL])
  })

  it('none for a GCE cell, a direct edge answer no front door maps, or flag off/absent', () => {
    expect(edgeAlternateCellUrls(edgeConfig(byCountry), COHORT_HOST, 'us-central1', 'CN', { cellId: 'us-c1', cellUrl: GCE_URL })).toBeUndefined()
    expect(edgeAlternateCellUrls(edgeConfig(byCountry), COHORT_HOST, 'us-central1', 'US', onEdge(EDGE_URL))).toBeUndefined()
    expect(edgeAlternateCellUrls(edgeConfig({ ...byCountry, alternates: 'off' }), COHORT_HOST, 'us-central1', 'CN', onEdge(DOOR))).toBeUndefined()
    const { alternates: _, ...absent } = byCountry
    expect(edgeAlternateCellUrls(edgeConfig(absent), COHORT_HOST, 'us-central1', 'CN', onEdge(DOOR))).toBeUndefined()
  })

  it("'listed' covers only hosts frontDoor lists by id, in both directions", () => {
    const listedByCountry: EdgeControlFlags = { ...byCountry, alternates: 'listed' }
    expect(edgeAlternateCellUrls(edgeConfig(listedByCountry), COHORT_HOST, 'us-central1', 'CN', onEdge(EDGE_URL))).toBeUndefined()
    expect(edgeAlternateCellUrls(edgeConfig(listedByCountry), COHORT_HOST, 'us-central1', 'CN', onEdge(DOOR))).toBeUndefined()
  })

  it('follows ORCA_RELAY_EDGE_FRONT_DOOR_URLS: none without it, none for a door outside it', () => {
    expect(edgeAlternateCellUrls(edgeConfig(byCountry, null), COHORT_HOST, 'us-central1', 'CN', onEdge(EDGE_URL))).toBeUndefined()
    expect(edgeAlternateCellUrls(edgeConfig(byCountry, null), COHORT_HOST, 'us-central1', 'CN', onEdge(DOOR))).toBeUndefined()
    const other = new Set(['https://other.relay.example.test'])
    expect(edgeAlternateCellUrls(edgeConfig(byCountry, other), COHORT_HOST, 'us-central1', 'CN', onEdge(EDGE_URL))).toBeUndefined()
    expect(edgeAlternateCellUrls(edgeConfig(byCountry, other), COHORT_HOST, 'us-central1', 'CN', onEdge(DOOR))).toBeUndefined()
  })

  it('a region excluding the country maps no front door by country, so no alternate', () => {
    const excluded: EdgeControlFlags = { ...byCountry, regionExcludeCountries: { 'us-central1': ['CN'] } }
    expect(edgeAlternateCellUrls(edgeConfig(excluded), COHORT_HOST, 'us-central1', 'CN', onEdge(EDGE_URL))).toBeUndefined()
  })
})

describe('POST /v1/assign alternateCellUrls', () => {
  // A listed host is answered through the front door; an allow-listed host with no mapping on the edge URL.
  const doorFlags = (alternates?: EdgeControlFlags['alternates']): EdgeControlFlags => ({
    mode: 'on',
    frontDoor: { url: DOOR, hosts: [LISTED_HOST] },
    ...(alternates ? { alternates } : {})
  })

  it('without the capability header: no field, and the answer parses under the shipped strict schema', async () => {
    const h = await harness({ current: doorFlags('country') })
    const body = await h.assign(LISTED_HOST)
    expect(body).toMatchObject({ cellUrl: DOOR })
    expect(shape(body)).toEqual(['assignmentEpoch', 'cellUrl', 'lease', 'v'])
    expect(ShippedAssignmentResponseSchema.safeParse(body).success).toBe(true)
  })

  it('with the header but the flag off or absent: no field', async () => {
    for (const alternates of [undefined, 'off'] as const) {
      const h = await harness({ current: doorFlags(alternates) })
      const body = await h.assign(LISTED_HOST, CAPABLE)
      expect(body).toMatchObject({ cellUrl: DOOR })
      expect(shape(body)).toEqual(['assignmentEpoch', 'cellUrl', 'lease', 'v'])
    }
  })

  it('header and flag on: a host answered through the front door gets the edge URL', async () => {
    const h = await harness({ current: doorFlags('listed') })
    const body = await h.assign(LISTED_HOST, CAPABLE)
    expect(body).toMatchObject({ v: 1, cellUrl: DOOR, alternateCellUrls: [EDGE_URL] })
    expect(ShippedAssignmentResponseSchema.safeParse(body).success).toBe(false)
    // A re-ask (the sticky keep) answers the same.
    expect(await h.assign(LISTED_HOST, CAPABLE)).toMatchObject({ cellUrl: DOOR, alternateCellUrls: [EDGE_URL] })
  })

  it('header and flag on: a host still on the edge URL that the flags now map gets the front door', async () => {
    const flags = { current: doorFlags('country') }
    flags.current.frontDoor = { url: DOOR }
    const h = await harness(flags)
    // On the edge URL before the host was mapped...
    expect(await h.assign(COHORT_HOST, CAPABLE)).toMatchObject({ cellUrl: EDGE_URL })
    // ...then listed: a non-reconnect ask keeps the edge URL (sticky) and offers the front door.
    flags.current = { ...flags.current, frontDoor: { url: DOOR, hosts: [COHORT_HOST] } }
    const body = await h.assign(COHORT_HOST, CAPABLE)
    expect(body).toMatchObject({ cellUrl: EDGE_URL, alternateCellUrls: [DOOR] })
  })

  it('header and flag on: an edge host no front door maps, and a GCE host, get none', async () => {
    const h = await harness({ current: doorFlags('country') })
    const edgeBody = await h.assign(COHORT_HOST, CAPABLE)
    expect(edgeBody).toMatchObject({ cellUrl: EDGE_URL })
    expect(shape(edgeBody)).toEqual(['assignmentEpoch', 'cellUrl', 'lease', 'v'])
    const gceBody = await h.assign(OTHER_HOST, CAPABLE)
    expect(gceBody).toMatchObject({ cellUrl: GCE_URL })
    expect(shape(gceBody)).toEqual(['assignmentEpoch', 'cellUrl', 'lease', 'v'])
  })

  it('without ORCA_RELAY_EDGE_FRONT_DOOR_URLS: none, whatever the flags say', async () => {
    const h = await harness({ current: doorFlags('country') }, null)
    const body = await h.assign(LISTED_HOST, CAPABLE)
    expect(shape(body)).toEqual(['assignmentEpoch', 'cellUrl', 'lease', 'v'])
  })
})
