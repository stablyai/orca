import { RELAY_REGIONS, type RelayRegion } from '@orca-cloud/relay-contract/relay-regions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RelayConfig } from './config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'
import type { EdgeAdmin, EdgeAssignBody, EdgeDrainResult } from './edge-admin-client.js'
import { parseEdgeControl, parseEdgeControlOver, type EdgeControlFlags } from './edge-relay-control.js'
import {
  EDGE_CELL_ID,
  EdgeAssignments,
  EdgeMoveDeferredError,
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
// Bucket in [500, 1000): in us-central1's cohort, out of asia-east2's (the incident's flapping hosts).
const splitHost = hosts.find((host) => edgeCohortBucketPermille(host) >= 500)!
// Bucket under 500: in both.
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
    drain: vi.fn(async (relayHostId: string): Promise<EdgeDrainResult> => {
      drained.push(relayHostId)
      return { outcome: 'idle' }
    })
  } as unknown as EdgeAdmin
  const drained: string[] = []
  const config = edgeConfig(flags)
  const edge = new EdgeAssignments(database, config, Date.now, admin)
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
  const sweep = async () => {
    drained.length = 0
    await new EdgeEvacuation(database, config, admin, EDGE_CELL_ID, Date.now, () => 0).sweep()
    return [...drained]
  }
  return { database, edge, pushes, exports, assign, recorded, sweep }
}

// What shipped desktops send (src/main/runtime/mobile-cloud-relay): the initial open and the drain
// reconnect name the desktop's preferred region; the hourly region refresh names none, and neither
// does the retry after a director refused the named region.
const open = (region: RelayRegion) => ({ preferredRegion: region, reconnect: true, regionCorrection: { v: 1, action: 'issue-window' } })
const drain = (region: RelayRegion) => ({ preferredRegion: region, reconnect: true })
const refresh = { reconnect: true, regionCorrection: { v: 1, action: 'issue-window' } }
const retry = {}
const life = (region: RelayRegion) => [open(region), refresh, refresh, drain(region), refresh, retry, refresh, drain(region), refresh]

const hostFlags = (): EdgeControlFlags => ({ mode: 'on', regionRolloutPermille: { ...DIVERGENT }, cohortRegion: 'host' })

describe("edge cohort by host (cohortRegion 'host')", () => {
  it('never flaps an Asian host whose regionless refreshes would count as us-central1', async () => {
    const flags = hostFlags()
    const d = await director(() => flags)
    const answers: string[] = []
    for (let round = 0; round < 3; round += 1) {
      for (const ask of life('asia-east2')) { answers.push(await d.assign(splitHost, ask)) }
    }
    // Out of asia-east2's cohort: never moved on, by any ask.
    expect(answers.every((url) => url === CELL_URL)).toBe(true)
    expect(d.pushes).toEqual([])
    expect(d.exports).toEqual([])
  })

  it('keeps a host its named region admits on the edge through every regionless ask', async () => {
    const flags = hostFlags()
    const d = await director(() => flags)
    for (const [host, region] of [[lowHost, 'asia-east2'], [splitHost, 'us-central1']] as const) {
      for (let round = 0; round < 3; round += 1) {
        for (const ask of life(region)) { expect(await d.assign(host, ask)).toBe(EDGE_URL) }
      }
      expect(await d.recorded(host)).toBe(region)
    }
    expect(d.pushes).toEqual([lowHost, splitHost])
    expect(d.exports).toEqual([])
    expect(await d.sweep()).toEqual([])
  })

  it('never moves a host onto the edge on a regionless ask (the review scenario)', async () => {
    const flags = hostFlags()
    const d = await director(() => flags)
    const answers = [
      await d.assign(splitHost, { preferredRegion: 'asia-east2' }),
      await d.assign(splitHost, refresh),
      await d.assign(splitHost, { preferredRegion: 'asia-east2' })
    ]
    flags.regionRolloutPermille = { ...DIVERGENT, 'asia-east2': 0 }
    answers.push(await d.assign(splitHost, { preferredRegion: 'asia-east2' }))
    expect(answers).toEqual([CELL_URL, CELL_URL, CELL_URL, CELL_URL])
    expect(d.pushes).toEqual([])
  })

  it('drains and moves off an Asian host when asia-east2 is aborted, by the sweep and by its refresh', async () => {
    const flags = hostFlags()
    const d = await director(() => flags)
    expect(await d.assign(lowHost, open('asia-east2'))).toBe(EDGE_URL)
    expect(await d.assign(lowHost, refresh)).toBe(EDGE_URL)
    expect(await d.assign(splitHost, open('us-central1'))).toBe(EDGE_URL)
    flags.regionRolloutPermille = { ...DIVERGENT, 'asia-east2': 0 }
    // The sweep and a regionless ask both judge it by its recorded asia-east2.
    expect(await d.sweep()).toEqual([lowHost])
    expect(await d.assign(lowHost, refresh)).toBe(CELL_URL)
    expect(d.exports).toEqual([lowHost])
    // And it is not moved back by a later refresh, which would count as us-central1 under 'ask'.
    expect(await d.assign(lowHost, refresh)).toBe(CELL_URL)
    expect(await d.assign(splitHost, refresh)).toBe(EDGE_URL)
    expect(d.pushes).toEqual([lowHost, splitHost])
  })

  it('heals a us-central1 record a regionless ask wrote before the flag at the next named ask', async () => {
    // Under 'ask' the refresh kept the host and rewrote its record to us-central1.
    const flags: EdgeControlFlags = { mode: 'on', regionRolloutPermille: { ...DIVERGENT } }
    const d = await director(() => flags)
    expect(await d.assign(splitHost, refresh)).toBe(EDGE_URL)
    expect(await d.recorded(splitHost)).toBe('us-central1')
    flags.cohortRegion = 'host'
    // Refreshes keep it (judged by the stale record), its next named ask moves it off, for good.
    expect(await d.assign(splitHost, refresh)).toBe(EDGE_URL)
    expect(await d.assign(splitHost, drain('asia-east2'))).toBe(CELL_URL)
    expect(d.exports).toEqual([splitHost])
    for (const ask of life('asia-east2')) { expect(await d.assign(splitHost, ask)).toBe(CELL_URL) }
    expect(d.pushes).toEqual([splitHost])
  })

  it('still moves off on mode off and on a named region whose rollout no longer admits it', async () => {
    const flags = hostFlags()
    const d = await director(() => flags)
    expect(await d.assign(splitHost, open('us-central1'))).toBe(EDGE_URL)
    flags.regionRolloutPermille = { 'us-central1': 0, 'asia-east2': 500 }
    expect(await d.assign(splitHost, drain('us-central1'))).toBe(CELL_URL)
    flags.regionRolloutPermille = { ...DIVERGENT }
    expect(await d.assign(splitHost, open('us-central1'))).toBe(EDGE_URL)
    flags.mode = 'off'
    expect(await d.assign(splitHost, refresh)).toBe(CELL_URL)
    expect(d.exports).toEqual([splitHost, splitHost])
  })

  it('judges a regionless ask against the recorded region for country exclusion', async () => {
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
    await edge.moveToEdge(identity, 0, 'asia-east2')
    const judged = await edge.judgeCohort(identity, undefined)
    expect(judged).toEqual({ by: 'record', region: 'asia-east2' })
    // Under 'ask' a CN refresh counted as us-central1 (no exclusion there) and kept it.
    expect(inEdgeCohort(config, splitHost, undefined, 'user-1', 'CN')).toBe(true)
    expect(inEdgeCohort(config, splitHost, 'asia-east2', 'user-1', 'CN')).toBe(false)
    expect(inEdgeCohort(config, splitHost, 'asia-east2', 'user-1', 'HK')).toBe(true)
  })

  it('re-checks under the row lock: a regionless ask never moves a host that left meanwhile', async () => {
    for (const frontDoorUrls of [undefined, new Set(['https://door.example.test'])]) {
      const flags = hostFlags()
      const config = edgeConfig(() => flags, frontDoorUrls ? { frontDoorUrls } : {})
      const database = await openInMemoryRelayDatabase()
      databases.push(database)
      const edge = new EdgeAssignments(database, config)
      await edge.ensureEdgeCell()
      const identity = { userId: 'user-1', relayHostId: lowHost }
      await edge.moveToEdge(identity, 0, 'asia-east2')
      expect(await edge.judgeCohort(identity, undefined)).toEqual({ by: 'record', region: 'asia-east2' })
      // Another director placed it on a cell between the read and the lock.
      await database.query(`UPDATE relay_assignments SET cell_id = 'us-c1', assignment_epoch = 7`)
      const route = frontDoorUrls ? { switchable: false } : undefined
      await expect(edge.moveToEdge(identity, 0, 'asia-east2', route, { keepOnly: true })).rejects.toEqual(
        new EdgeMoveDeferredError('not_on_edge')
      )
      const row = (await database.query(`SELECT cell_id, assignment_epoch FROM relay_assignments`))[0]!
      expect([row.cell_id, Number(row.assignment_epoch)]).toEqual(['us-c1', 7])
      // No row at all: nothing inserted either.
      const fresh = { userId: 'user-1', relayHostId: splitHost }
      await expect(edge.moveToEdge(fresh, 0, undefined, route, { keepOnly: true })).rejects.toBeInstanceOf(EdgeMoveDeferredError)
      expect(await database.query(`SELECT 1 FROM relay_assignments WHERE relay_host_id = ?`, [splitHost])).toEqual([])
      // On the edge, keepOnly answers as before.
      await database.query(`UPDATE relay_assignments SET cell_id = ?`, [EDGE_CELL_ID])
      expect((await edge.moveToEdge(identity, 0, 'asia-east2', route, { keepOnly: true })).cellId).toBe(EDGE_CELL_ID)
    }
  })

  it('reads the row only for a regionless ask of a host that may be on the edge, and never twice', async () => {
    const flags: EdgeControlFlags = { ...hostFlags(), leaveCeilingPermille: 1000 }
    const d = await director(() => flags)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const judge = vi.spyOn(d.edge, 'judgeCohort')
    const leave = vi.spyOn(d.edge, 'leaveEdge')
    const query = vi.spyOn(d.database, 'query')
    const reads = () => query.mock.calls.filter(([sql]) => sql.includes('LEFT JOIN relay_edge_host_regions')).length
    // Named ask: judged as under 'ask', no read.
    await d.assign(splitHost, drain('asia-east2'))
    expect(reads()).toBe(0)
    expect(leave).toHaveBeenCalledTimes(1)
    // Regionless ask of a host off the edge: one read, and no leave read after it.
    await d.assign(splitHost, refresh)
    expect(reads()).toBe(1)
    expect(leave).toHaveBeenCalledTimes(1)
    // Above every rollout and the ceiling: no edge row is possible, so nothing is read.
    flags.leaveCeilingPermille = 500
    flags.regionRolloutPermille = { 'us-central1': 500, 'asia-east2': 500 }
    await d.assign(splitHost, refresh)
    expect(reads()).toBe(1)
    expect(await judge.mock.results.at(-1)!.value).toEqual({ by: 'none' })
  })

  it('judges hosts listed by id as before: their region never matters', async () => {
    const flags = hostFlags()
    const config = edgeConfig(() => flags, { allowHosts: new Set([splitHost]), denyHosts: new Set([lowHost]) })
    const database = await openInMemoryRelayDatabase()
    databases.push(database)
    const edge = new EdgeAssignments(database, config)
    await edge.ensureEdgeCell()
    const query = vi.spyOn(database, 'query')
    expect(await edge.judgeCohort({ userId: 'user-1', relayHostId: splitHost }, undefined)).toEqual({ by: 'ask', region: undefined })
    expect(await edge.judgeCohort({ userId: 'user-1', relayHostId: lowHost }, undefined)).toEqual({ by: 'ask', region: undefined })
    expect(query).not.toHaveBeenCalled()
  })
})

describe('edge cohort by ask (cohortRegion absent or ask)', () => {
  it('decides as before: an Asian host still flaps at every regionless refresh (the incident)', async () => {
    for (const cohortRegion of [undefined, 'ask'] as const) {
      const flags: EdgeControlFlags = {
        mode: 'on',
        regionRolloutPermille: { ...DIVERGENT },
        ...(cohortRegion ? { cohortRegion } : {})
      }
      const d = await director(() => flags)
      const answers: string[] = []
      for (const ask of life('asia-east2')) { answers.push(await d.assign(splitHost, ask)) }
      expect(answers).toEqual([CELL_URL, EDGE_URL, EDGE_URL, CELL_URL, EDGE_URL, EDGE_URL, EDGE_URL, CELL_URL, EDGE_URL])
      expect(d.pushes).toHaveLength(3)
      expect(d.exports).toHaveLength(2)
      // The review scenario: the refresh moves it on, and an asia-east2 abort still moves it off.
      const r = await director(() => flags)
      const scenario = [
        await r.assign(splitHost, { preferredRegion: 'asia-east2' }),
        await r.assign(splitHost, refresh),
        await r.assign(splitHost, { preferredRegion: 'asia-east2' })
      ]
      expect(scenario).toEqual([CELL_URL, EDGE_URL, CELL_URL])
    }
  })

  it('never reads the row, on any ask', async () => {
    for (const flags of [
      { mode: 'on', regionRolloutPermille: { ...DIVERGENT } },
      { mode: 'on', regionRolloutPermille: { ...DIVERGENT }, cohortRegion: 'ask' },
      // 'host' with the mode off: nobody is in the cohort.
      { mode: 'off', regionRolloutPermille: { ...DIVERGENT }, cohortRegion: 'host' }
    ] as EdgeControlFlags[]) {
      const database = await openInMemoryRelayDatabase()
      databases.push(database)
      const edge = new EdgeAssignments(database, edgeConfig(() => flags))
      await edge.ensureEdgeCell()
      const identity = { userId: 'user-1', relayHostId: splitHost }
      await edge.moveToEdge(identity, 0, 'us-central1')
      const query = vi.spyOn(database, 'query')
      for (const region of [...RELAY_REGIONS, undefined] as (RelayRegion | undefined)[]) {
        expect(await edge.judgeCohort(identity, region)).toEqual({ by: 'ask', region })
      }
      expect(query).not.toHaveBeenCalled()
    }
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

  it('drains exactly the edge hosts the assign path would move off', async () => {
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
      const keeps = async (host: string, asked: RelayRegion | undefined) => {
        const judged = await edge.judgeCohort({ userId: 'user-1', relayHostId: host }, asked)
        return judged.by !== 'none' && inEdgeCohort(config, host, judged.region, 'user-1', null)
      }
      for (const host of sample) {
        const recorded = recordedOf.get(host)
        if ((RELAY_REGIONS as readonly (string | undefined)[]).includes(recorded)) {
          // A recorded host: its regionless asks and an ask naming its region (what its desktop
          // sends) decide alike, and the sweep drains it exactly when they would move it off.
          const kept = [await keeps(host, undefined), await keeps(host, recorded as RelayRegion)]
          expect(kept[0]).toBe(kept[1])
          expect(drained.includes(host)).toBe(!kept[0])
        } else {
          // No valid record (moved before records existed): the sweep judges 'any', so it never
          // drains a host some ask would keep; its next ask records a region.
          const kept = await Promise.all(([...RELAY_REGIONS, undefined] as (RelayRegion | undefined)[]).map((asked) => keeps(host, asked)))
          expect(drained.includes(host)).toBe(!kept.some(Boolean))
        }
      }
    }
  })
})
