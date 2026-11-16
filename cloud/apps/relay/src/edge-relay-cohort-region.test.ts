import { RELAY_REGIONS, type RelayRegion } from '@orca-cloud/relay-contract/relay-regions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RelayConfig } from './config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'
import type { EdgeAdmin, EdgeAssignBody, EdgeDrainResult } from './edge-admin-client.js'
import { parseEdgeControl, parseEdgeControlOver, type EdgeControlFlags } from './edge-relay-control.js'
import {
  EDGE_CELL_ID,
  EdgeAssignments,
  edgeCohortBucketPermille,
  inEdgeCohort,
  type EdgeRelayConfig
} from './edge-relay.js'
import { EdgeEvacuation } from './edge-relay-evacuation.js'

const fakes = vi.hoisted(() => ({
  verifyRelayToken: vi.fn(async (token: string) => ({ sub: 'user-1', relayHostId: token }))
}))

vi.mock('./relay-token-verifier.js', () => ({
  createRelayTokenVerifier: () => fakes.verifyRelayToken,
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

import { createRelayApp } from './app.js'

const EDGE_URL = 'https://edge.relay.example.test'
const CELL_URL = 'https://us-c1.relay.example.test'
// The incident's flags: us-central1 fully on, asia-east2 at half.
const DIVERGENT = { 'us-central1': 1000, 'asia-east2': 500 } as const

const hosts = Array.from({ length: 400 }, (_, index) => `cohortregion${String(index).padStart(4, '0')}`)
// In the cohort when an ask names us-central1 (or no region), out when it names asia-east2.
const splitHost = hosts.find((host) => edgeCohortBucketPermille(host) >= 500)!
const lowHost = hosts.find((host) => edgeCohortBucketPermille(host) < 500)!

const databases: RelayDatabase[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const database of databases.splice(0)) { await database.close() }
})

function relayConfig(): RelayConfig {
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

function edgeConfig(flags: () => EdgeControlFlags, overrides: Partial<EdgeRelayConfig> = {}): EdgeRelayConfig {
  return {
    cellUrl: EDGE_URL,
    rolloutPercent: 0,
    allowHosts: new Set(),
    denyHosts: new Set(),
    regions: new Set(['us-central1']),
    control: flags,
    ...overrides
  }
}

// A director with a phase 2 edge: moves push, leaves export, and the cell path really re-places the
// row (so a host that left is moved back with a new push).
async function director(flags: () => EdgeControlFlags) {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // Asks minutes apart, as a desktop's are: never the director's per-host rate limit.
  vi.useFakeTimers({ toFake: ['Date'] })
  const database = await openInMemoryRelayDatabase()
  databases.push(database)
  const pushes: string[] = []
  const exports: string[] = []
  const admin = {
    assign: vi.fn(async (body: EdgeAssignBody) => {
      if (body.cellId === EDGE_CELL_ID || body.cellId === undefined) { pushes.push(body.relayHostId) }
      return { outcome: 'applied' as const, assignmentEpoch: body.assignmentEpoch }
    }),
    exportHost: vi.fn(async (relayHostId: string) => {
      exports.push(relayHostId)
      return { outcome: 'exported' as const, assignment: null, devices: [] }
    }),
    drain: vi.fn(async (): Promise<EdgeDrainResult> => ({ outcome: 'idle' }))
  } as unknown as EdgeAdmin
  const edge = new EdgeAssignments(database, edgeConfig(flags), Date.now, admin)
  await edge.ensureEdgeCell()
  const assignments = {
    assign: vi.fn(async (identity: { userId: string; relayHostId: string }) => {
      const row = (
        await database.query(`SELECT assignment_epoch FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`, [
          identity.userId,
          identity.relayHostId
        ])
      )[0]
      const epoch = Number(row?.assignment_epoch ?? 0) + 1
      await database.query(
        `INSERT INTO relay_assignments
         (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at, last_activity_at,
          reserved_controls, reserved_splices, reserved_invites, pending_installs,
          pending_confirmations, migration_leases)
         VALUES (?, ?, 'us-c1', ?, 0, 0, 0, 0, 0, 0, 0, 0)
         ON CONFLICT (user_id, relay_host_id) DO UPDATE SET cell_id = 'us-c1', assignment_epoch = excluded.assignment_epoch`,
        [identity.userId, identity.relayHostId, epoch]
      )
      return {
        ...identity,
        cellId: 'us-c1',
        cellUrl: CELL_URL,
        region: 'us-central1' as const,
        assignmentEpoch: epoch,
        leaseExpiresAt: Date.now() + 90_000
      }
    }),
    resolve: vi.fn(async () => null),
    exchangeRegionCorrection: vi.fn(async () => undefined)
  }
  const app = createRelayApp(relayConfig(), {
    store: { resolveResume: vi.fn(async () => ({ userId: 'user-1' })) } as never,
    assignments: assignments as never,
    reservePlacement: { plan: vi.fn(async () => ({ kind: 'database' })), raiseEpochFloor: vi.fn(), rowEpochFloor: () => 0 } as never,
    edgeAssignments: edge,
    drain: vi.fn(),
    ready: vi.fn(async () => true)
  })
  const assign = async (relayHostId: string, ask: Record<string, unknown>): Promise<string> => {
    vi.setSystemTime(Date.now() + 10 * 60_000)
    const response = await app.request('/v1/assign', {
      method: 'POST',
      headers: { authorization: `Bearer ${relayHostId}`, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, relayHostId, ...ask })
    })
    expect(response.status).toBe(200)
    return ((await response.json()) as { cellUrl: string }).cellUrl
  }
  const recorded = async (relayHostId: string) =>
    (
      await database.query(`SELECT region FROM relay_edge_host_regions WHERE user_id = 'user-1' AND relay_host_id = ?`, [
        relayHostId
      ])
    )[0]?.region
  return { database, edge, pushes, exports, assign, recorded }
}

// What shipped desktops send over a host's life: asks without a region, the initial open and the
// hourly refresh (issue-window), each naming whichever region the desktop prefers at that moment.
const ASKS: Record<string, unknown>[] = [
  {},
  { preferredRegion: 'asia-east2', reconnect: true, regionCorrection: { v: 1, action: 'issue-window' } },
  { preferredRegion: 'us-central1' },
  { preferredRegion: 'asia-east2' },
  { reconnect: true },
  { preferredRegion: 'asia-east2', reconnect: true, regionCorrection: { v: 1, action: 'issue-window' } },
  { preferredRegion: 'us-central1', reconnect: true, regionCorrection: { v: 1, action: 'issue-window' } },
  { preferredRegion: 'asia-east2' }
]

describe("edge cohort by host (cohortRegion 'host')", () => {
  it('never flaps a host whose asks alternate regions under divergent regional rollouts', async () => {
    const flags: EdgeControlFlags = { mode: 'on', regionRolloutPermille: { ...DIVERGENT }, cohortRegion: 'host' }
    const d = await director(() => flags)
    const answers: string[] = []
    for (let round = 0; round < 3; round += 1) {
      for (const ask of ASKS) { answers.push(await d.assign(splitHost, ask)) }
    }
    // Moved on by the first ask (no region: us-central1), then kept whatever the asks name.
    expect(answers.every((url) => url === EDGE_URL)).toBe(true)
    expect(d.pushes).toEqual([splitHost])
    expect(d.exports).toEqual([])
    // Kept asks never rewrite the region it moved under.
    expect(await d.recorded(splitHost)).toBe('us-central1')
  })

  it('moves a host on only by an ask whose region admits it, then keeps it', async () => {
    const flags: EdgeControlFlags = { mode: 'on', regionRolloutPermille: { ...DIVERGENT }, cohortRegion: 'host' }
    const d = await director(() => flags)
    // Off the edge, an Asian ask is judged by asia-east2 (500): out.
    expect(await d.assign(splitHost, { preferredRegion: 'asia-east2' })).toBe(CELL_URL)
    expect(d.pushes).toEqual([])
    expect(await d.assign(splitHost, { preferredRegion: 'us-central1' })).toBe(EDGE_URL)
    expect(await d.assign(splitHost, { preferredRegion: 'asia-east2' })).toBe(EDGE_URL)
    expect(d.pushes).toEqual([splitHost])
    expect(d.exports).toEqual([])
    // A host under both rollouts moved by an Asian ask keeps asia-east2 as its region.
    for (const ask of ASKS) { expect(await d.assign(lowHost, { preferredRegion: 'asia-east2', ...ask })).toBe(EDGE_URL) }
    expect(await d.recorded(lowHost)).toBe('asia-east2')
  })

  it('still leaves when the rollout of the region it moved under no longer admits it', async () => {
    const flags: EdgeControlFlags = { mode: 'on', regionRolloutPermille: { ...DIVERGENT }, cohortRegion: 'host' }
    const d = await director(() => flags)
    expect(await d.assign(splitHost, { preferredRegion: 'us-central1' })).toBe(EDGE_URL)
    flags.regionRolloutPermille = { 'us-central1': 0, 'asia-east2': 500 }
    expect(await d.assign(splitHost, { preferredRegion: 'us-central1' })).toBe(CELL_URL)
    expect(d.exports).toEqual([splitHost])
    // Mode off empties the cohort, recorded region or not.
    flags.regionRolloutPermille = { ...DIVERGENT }
    expect(await d.assign(splitHost, {})).toBe(EDGE_URL)
    flags.mode = 'off'
    expect(await d.assign(splitHost, {})).toBe(CELL_URL)
  })

  it('judges country exclusion against the region the host moved under', async () => {
    const flags: EdgeControlFlags = {
      mode: 'on',
      regionRolloutPermille: { 'us-central1': 1000, 'asia-east2': 1000 },
      regionExcludeCountries: { 'asia-east2': ['CN'] },
      cohortRegion: 'host'
    }
    const config = edgeConfig(() => flags)
    const database = await openInMemoryRelayDatabase()
    databases.push(database)
    const edge = new EdgeAssignments(database, config)
    await edge.ensureEdgeCell()
    const identity = { userId: 'user-1', relayHostId: splitHost }
    await edge.moveToEdge(identity, 0, 'us-central1')
    // Moved under us-central1 (no exclusion there): an Asian ask from CN no longer flips it off.
    const region = await edge.cohortRegion(identity, 'asia-east2')
    expect(region).toBe('us-central1')
    expect(inEdgeCohort(config, splitHost, region, 'user-1', 'CN')).toBe(true)
    // Moved under asia-east2: CN is excluded whatever its asks name.
    await database.query(`UPDATE relay_edge_host_regions SET region = 'asia-east2'`)
    const asia = await edge.cohortRegion(identity, 'us-central1')
    expect(asia).toBe('asia-east2')
    expect(inEdgeCohort(config, splitHost, asia, 'user-1', 'CN')).toBe(false)
    expect(inEdgeCohort(config, splitHost, asia, 'user-1', 'HK')).toBe(true)
  })

  it('ignores a stale record of a host not on the edge, and keeps the front door and allow lists', async () => {
    const flags: EdgeControlFlags = { mode: 'on', regionRolloutPermille: { ...DIVERGENT }, cohortRegion: 'host' }
    const config = edgeConfig(() => flags, { allowHosts: new Set([hosts[1]!]) })
    const database = await openInMemoryRelayDatabase()
    databases.push(database)
    const edge = new EdgeAssignments(database, config)
    await edge.ensureEdgeCell()
    const identity = { userId: 'user-1', relayHostId: splitHost }
    await edge.moveToEdge(identity, 0, 'us-central1')
    // A record left behind (a failed forget) after the host went to a cell.
    await database.query(`UPDATE relay_assignments SET cell_id = 'us-c1'`)
    expect(await edge.cohortRegion(identity, 'asia-east2')).toBe('asia-east2')
    expect(await edge.cohortRegion({ userId: 'user-1', relayHostId: 'neverassigned001' }, undefined)).toBeUndefined()
    // Allow lists win whatever the region.
    expect(inEdgeCohort(config, hosts[1]!, 'asia-east2')).toBe(true)
  })
})

describe('edge cohort by ask (cohortRegion absent or ask)', () => {
  it('decides as before: the same asks still flap the host (the incident)', async () => {
    for (const cohortRegion of [undefined, 'ask'] as const) {
      const flags: EdgeControlFlags = {
        mode: 'on',
        regionRolloutPermille: { ...DIVERGENT },
        ...(cohortRegion ? { cohortRegion } : {})
      }
      const d = await director(() => flags)
      const answers: string[] = []
      for (const ask of ASKS) { answers.push(await d.assign(splitHost, ask)) }
      expect(answers).toEqual([EDGE_URL, CELL_URL, EDGE_URL, CELL_URL, EDGE_URL, CELL_URL, EDGE_URL, CELL_URL])
      expect(d.pushes).toHaveLength(4)
      expect(d.exports).toHaveLength(4)
    }
  })

  it('never reads the recorded region, and answers the ask region on every path', async () => {
    const database = await openInMemoryRelayDatabase()
    databases.push(database)
    const flags: EdgeControlFlags = { mode: 'on', regionRolloutPermille: { ...DIVERGENT } }
    const edge = new EdgeAssignments(database, edgeConfig(() => flags))
    await edge.ensureEdgeCell()
    const identity = { userId: 'user-1', relayHostId: splitHost }
    await edge.moveToEdge(identity, 0, 'us-central1')
    const query = vi.spyOn(database, 'query')
    for (const region of [...RELAY_REGIONS, undefined] as (RelayRegion | undefined)[]) {
      expect(await edge.cohortRegion(identity, region)).toBe(region)
    }
    // 'host' with the mode off reads nothing either: nobody is in the cohort.
    flags.cohortRegion = 'host'
    flags.mode = 'off'
    expect(await edge.cohortRegion(identity, 'asia-east2')).toBe('asia-east2')
    expect(query).not.toHaveBeenCalled()
  })

  it('parses as before without the key; a bad value drops only this key and keeps the last one', () => {
    expect(parseEdgeControl({ v: 1, flags: { mode: 'on', regionRolloutPermille: { ...DIVERGENT } } })).toEqual({
      flags: { mode: 'on', regionRolloutPermille: { ...DIVERGENT } },
      ignoredKeys: []
    })
    expect(parseEdgeControl({ v: 1, flags: { cohortRegion: 'host' } })).toEqual({
      flags: { mode: 'on', cohortRegion: 'host' },
      ignoredKeys: []
    })
    expect(parseEdgeControl({ v: 1, flags: { cohortRegion: 'ask' } })).toEqual({
      flags: { mode: 'on', cohortRegion: 'ask' },
      ignoredKeys: []
    })
    const previous: EdgeControlFlags = { mode: 'on', cohortRegion: 'host' }
    expect(parseEdgeControlOver({ v: 1, flags: { rolloutPermille: 5, cohortRegion: 'hosts' } }, previous)).toEqual({
      flags: { mode: 'on', rolloutPermille: 5, cohortRegion: 'host' },
      ignoredKeys: ['cohortRegion']
    })
    expect(parseEdgeControl({ v: 1, flags: { cohortRegion: 7 } })).toEqual({ flags: { mode: 'on' }, ignoredKeys: ['cohortRegion'] })
    // Removing the key returns to judging by the ask.
    expect(parseEdgeControlOver({ v: 1, flags: {} }, previous)).toEqual({ flags: { mode: 'on' }, ignoredKeys: [] })
  })
})

describe('edge evacuation agrees with the assign path', () => {
  const flagSets: EdgeControlFlags[] = [
    { mode: 'on', regionRolloutPermille: { ...DIVERGENT }, cohortRegion: 'host' },
    { mode: 'on', regionRolloutPermille: { 'us-central1': 300, 'asia-east2': 800 }, cohortRegion: 'host' },
    { mode: 'on', regionRolloutPermille: { 'asia-east2': 0 }, rolloutPermille: 1000, cohortRegion: 'host' },
    // No regional values: the sweep still judges by the record, as the assign path does.
    { mode: 'on', rolloutPermille: 400, cohortRegion: 'host' },
    { mode: 'off', regionRolloutPermille: { ...DIVERGENT }, cohortRegion: 'host' }
  ]
  // 'retired-region': a record no longer a known region, judged like no record.
  const recordings: (string | undefined)[] = ['us-central1', 'asia-east2', 'retired-region', undefined]

  it('drains exactly the edge hosts the assign path would move off, for every ask region', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const sample = hosts.slice(0, 60)
    for (const flags of flagSets) {
      const config = edgeConfig(() => flags)
      const database = await openInMemoryRelayDatabase()
      databases.push(database)
      const drained: string[] = []
      const admin = {
        drain: async (relayHostId: string): Promise<EdgeDrainResult> => {
          drained.push(relayHostId)
          return { outcome: 'idle' }
        }
      } as unknown as EdgeAdmin
      const edge = new EdgeAssignments(database, config)
      await edge.ensureEdgeCell()
      const recordedOf = new Map<string, string | undefined>()
      for (const [index, host] of sample.entries()) {
        const region = recordings[index % recordings.length]
        recordedOf.set(host, region)
        await database.query(
          `INSERT INTO relay_assignments
           (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at, last_activity_at,
            reserved_controls, reserved_splices, reserved_invites, pending_installs,
            pending_confirmations, migration_leases)
           VALUES ('user-1', ?, ?, 1, 0, 0, 0, 0, 0, 0, 0, 0)`,
          [host, EDGE_CELL_ID]
        )
        if (region) {
          await database.query(
            `INSERT INTO relay_edge_host_regions (user_id, relay_host_id, region, recorded_at) VALUES ('user-1', ?, ?, 0)`,
            [host, region]
          )
        }
      }
      const evacuation = new EdgeEvacuation(database, config, admin, EDGE_CELL_ID, () => 1_000, () => 0)
      await evacuation.sweep()
      for (const host of sample) {
        const identity = { userId: 'user-1', relayHostId: host }
        const kept = await Promise.all(
          ([...RELAY_REGIONS, undefined] as (RelayRegion | undefined)[]).map(async (asked) =>
            inEdgeCohort(config, host, await edge.cohortRegion(identity, asked), 'user-1', null)
          )
        )
        if ((RELAY_REGIONS as readonly (string | undefined)[]).includes(recordedOf.get(host))) {
          // A recorded host: one decision whatever its asks name, and the sweep's is the same.
          expect(new Set(kept).size).toBe(1)
          expect(drained.includes(host)).toBe(!kept[0])
        } else {
          // No valid record (e.g. moved before records existed): the sweep judges 'any', so it never drains a
          // host some ask would keep, and its next ask records a region.
          expect(drained.includes(host)).toBe(!kept.some(Boolean))
        }
      }
    }
  })
})
