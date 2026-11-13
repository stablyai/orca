import { RELAY_DEFAULT_REGION, RELAY_REGIONS, type RelayRegion } from '@orca-cloud/relay-contract/relay-regions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'
import {
  edgeAnyRegionRolloutPermille,
  edgeRolloutPermille,
  parseEdgeControl,
  type EdgeControlFlags
} from './edge-relay-control.js'
import {
  EDGE_CELL_ID,
  EdgeAssignments,
  EdgeMoveDeferredError,
  edgeCohortBucketPermille,
  inEdgeCohort,
  mayBeOnEdge,
  type EdgeRelayConfig
} from './edge-relay.js'
import { EdgeEvacuation } from './edge-relay-evacuation.js'
import { EDGE_REGION_COUNTRY_EVENT, EdgeRegionCountryTally } from './edge-region-country-log.js'
import type { EdgeAdmin, EdgeDrainResult } from './edge-admin-client.js'

function config(flags: EdgeControlFlags, overrides: Partial<EdgeRelayConfig> = {}): EdgeRelayConfig {
  return {
    cellUrl: 'https://edge.relay.example.test',
    rolloutPercent: 0,
    allowHosts: new Set(),
    denyHosts: new Set(),
    regions: new Set(['us-central1']),
    control: () => flags,
    ...overrides
  }
}

const hosts = Array.from({ length: 600 }, (_, index) => `regionhost${String(index).padStart(6, '0')}`)
const hostUnder = (permille: number) => hosts.find((host) => edgeCohortBucketPermille(host) < permille)!
const hostAtOrAbove = (permille: number) => hosts.find((host) => edgeCohortBucketPermille(host) >= permille)!

// inEdgeCohort as it was before regional values and country exclusion.
function previousInEdgeCohort(
  config: EdgeRelayConfig,
  relayHostId: string,
  region: RelayRegion | undefined | 'any',
  userId?: string
): boolean {
  const flags = config.control!()
  if (flags.mode !== 'on') return false
  if (config.denyHosts.has(relayHostId)) return false
  if (config.allowHosts.has(relayHostId)) return true
  if (region !== 'any' && !config.regions.has(region ?? RELAY_DEFAULT_REGION)) return false
  if (userId !== undefined && config.allowUsers?.has(userId)) return true
  return edgeCohortBucketPermille(relayHostId) < edgeRolloutPermille(config.rolloutPercent, flags)
}

function previousMayBeOnEdge(config: EdgeRelayConfig, relayHostId: string, userId?: string): boolean {
  const flags = config.control!()
  if (flags.leaveCeilingPermille === undefined) return true
  if (config.allowHosts.has(relayHostId) || config.denyHosts.has(relayHostId)) return true
  if (userId !== undefined && config.allowUsers?.has(userId)) return true
  const ceiling = Math.max(flags.leaveCeilingPermille, edgeRolloutPermille(config.rolloutPercent, flags), config.rolloutPercent * 10)
  return edgeCohortBucketPermille(relayHostId) < ceiling
}

describe('edge cohort without regional flags', () => {
  it('decides exactly as before for every host, region, account, country and scope', () => {
    const flagSets: EdgeControlFlags[] = [
      { mode: 'on' },
      { mode: 'on', rolloutPermille: 0 },
      { mode: 'on', rolloutPermille: 37 },
      { mode: 'on', rolloutPermille: 500, leaveCeilingPermille: 700 },
      { mode: 'off', rolloutPermille: 1000 },
      { mode: 'down' }
    ]
    const scopes: ReadonlySet<RelayRegion>[] = [new Set(), new Set(['us-central1']), new Set(RELAY_REGIONS)]
    let compared = 0
    for (const flags of flagSets) {
      for (const regions of scopes) {
        for (const rolloutPercent of [0, 5, 100]) {
          const edge = config(flags, {
            regions,
            rolloutPercent,
            allowHosts: new Set([hosts[1]!]),
            denyHosts: new Set([hosts[2]!]),
            allowUsers: new Set(['user-team'])
          })
          for (const host of hosts.slice(0, 120)) {
            for (const region of [...RELAY_REGIONS, undefined, 'any'] as const) {
              for (const userId of [undefined, 'user-team', 'user-other']) {
                const before = previousInEdgeCohort(edge, host, region, userId)
                // No exclusion flag: the ask's country (known, unknown or not judged) changes nothing.
                for (const country of [undefined, null, 'CN', 'US']) {
                  expect(inEdgeCohort(edge, host, region, userId, country)).toBe(before)
                  compared += 1
                }
              }
              expect(mayBeOnEdge(edge, host)).toBe(previousMayBeOnEdge(edge, host))
              expect(mayBeOnEdge(edge, host, 'user-team')).toBe(previousMayBeOnEdge(edge, host, 'user-team'))
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(100_000)
  })
})

describe('edge regionRolloutPermille', () => {
  it('brings a listed region into scope at its own share; others keep the global share or stay out', () => {
    const flags: EdgeControlFlags = { mode: 'on', rolloutPermille: 1000, regionRolloutPermille: { 'asia-east2': 10 } }
    const edge = config(flags)
    expect(inEdgeCohort(edge, hostUnder(10), 'asia-east2')).toBe(true)
    expect(inEdgeCohort(edge, hostAtOrAbove(10), 'asia-east2')).toBe(false)
    // us-central1 is in the env scope: the global share.
    expect(inEdgeCohort(edge, hostAtOrAbove(10), 'us-central1')).toBe(true)
    expect(inEdgeCohort(edge, hostAtOrAbove(10), undefined)).toBe(true)
    // A region neither listed nor in the env scope stays out.
    expect(inEdgeCohort(config({ mode: 'on', rolloutPermille: 1000 }, { regions: new Set() }), hostUnder(10), 'asia-east2')).toBe(false)
    // A regional value also replaces the global share for an env-scoped region.
    const lowered = config({ mode: 'on', rolloutPermille: 1000, regionRolloutPermille: { 'us-central1': 0 } })
    expect(inEdgeCohort(lowered, hostUnder(10), 'us-central1')).toBe(false)
  })

  it('at 0 admits only allow-listed hosts and accounts', () => {
    const flags: EdgeControlFlags = { mode: 'on', regionRolloutPermille: { 'asia-east2': 0 } }
    const edge = config(flags, { allowHosts: new Set([hosts[1]!]), allowUsers: new Set(['user-team']) })
    expect(inEdgeCohort(edge, hostUnder(1), 'asia-east2')).toBe(false)
    expect(inEdgeCohort(edge, hosts[1]!, 'asia-east2')).toBe(true)
    expect(inEdgeCohort(edge, hostAtOrAbove(999), 'asia-east2', 'user-team')).toBe(true)
    expect(inEdgeCohort(edge, hostAtOrAbove(999), 'asia-east2', 'user-other')).toBe(false)
  })

  it("judges region 'any' by the highest in-scope share", () => {
    const flags: EdgeControlFlags = { mode: 'on', rolloutPermille: 10, regionRolloutPermille: { 'asia-east2': 500 } }
    expect(edgeAnyRegionRolloutPermille(config(flags), flags)).toBe(500)
    expect(inEdgeCohort(config(flags), hostUnder(500), 'any')).toBe(true)
    expect(inEdgeCohort(config(flags), hostAtOrAbove(500), 'any')).toBe(false)
    // The env-scoped region's global share wins when higher.
    const higher: EdgeControlFlags = { mode: 'on', rolloutPermille: 800, regionRolloutPermille: { 'asia-east2': 0 } }
    expect(edgeAnyRegionRolloutPermille(config(higher), higher)).toBe(800)
    // Out of the env scope, the global share does not count.
    expect(edgeAnyRegionRolloutPermille(config(higher, { regions: new Set() }), higher)).toBe(0)
    // Nothing in scope at all: the global share, as before.
    expect(edgeAnyRegionRolloutPermille(config({ mode: 'on', rolloutPermille: 30 }, { regions: new Set() }), { mode: 'on', rolloutPermille: 30 })).toBe(30)
  })

  it('raises the leave ceiling to every regional share', () => {
    const flags: EdgeControlFlags = {
      mode: 'on',
      rolloutPermille: 0,
      leaveCeilingPermille: 10,
      regionRolloutPermille: { 'asia-east2': 300 }
    }
    // A file like this is void (see the refine below); were it applied, regional hosts still read.
    expect(mayBeOnEdge(config(flags), hostUnder(300))).toBe(true)
    expect(mayBeOnEdge(config(flags), hostAtOrAbove(300))).toBe(false)
  })
})

describe('edge regionExcludeCountries', () => {
  const flags: EdgeControlFlags = {
    mode: 'on',
    rolloutPermille: 1000,
    regionRolloutPermille: { 'asia-east2': 1000 },
    regionExcludeCountries: { 'asia-east2': ['CN'] }
  }

  it('keeps hosts of an excluded country out of that region only', () => {
    const edge = config(flags)
    const host = hostUnder(1000)
    expect(inEdgeCohort(edge, host, 'asia-east2', undefined, 'CN')).toBe(false)
    expect(inEdgeCohort(edge, host, 'asia-east2', undefined, 'HK')).toBe(true)
    // Other regions are untouched, so today's cohort is unchanged.
    expect(inEdgeCohort(edge, host, 'us-central1', undefined, 'CN')).toBe(true)
    expect(inEdgeCohort(edge, host, undefined, undefined, 'CN')).toBe(true)
  })

  it('runs after deny and host allow, and before account allow and the share', () => {
    const host = hostUnder(1000)
    expect(inEdgeCohort(config(flags, { allowHosts: new Set([host]) }), host, 'asia-east2', undefined, 'CN')).toBe(true)
    expect(
      inEdgeCohort(config(flags, { allowHosts: new Set([host]), denyHosts: new Set([host]) }), host, 'asia-east2', undefined, 'HK')
    ).toBe(false)
    expect(inEdgeCohort(config(flags, { allowUsers: new Set(['user-team']) }), host, 'asia-east2', 'user-team', 'CN')).toBe(false)
    expect(inEdgeCohort(config(flags, { allowUsers: new Set(['user-team']) }), host, 'asia-east2', 'user-team', 'HK')).toBe(true)
    // Out of scope is out before the country is looked at.
    expect(inEdgeCohort(config({ mode: 'on', rolloutPermille: 1000 }, { regions: new Set() }), host, 'asia-east2', undefined, 'HK')).toBe(false)
  })

  it('lets an unknown country in unless the region excludes unknown countries', () => {
    const host = hostUnder(1000)
    expect(inEdgeCohort(config(flags), host, 'asia-east2', undefined, null)).toBe(true)
    const strict = config({ ...flags, regionExcludeUnknownCountry: { 'asia-east2': true } })
    expect(inEdgeCohort(strict, host, 'asia-east2', undefined, null)).toBe(false)
    expect(inEdgeCohort(strict, host, 'asia-east2', undefined, 'HK')).toBe(true)
    expect(inEdgeCohort(strict, host, 'us-central1', undefined, null)).toBe(true)
  })

  it('is not judged without an ask (the sweep passes no country)', () => {
    const strict = config({ ...flags, regionExcludeUnknownCountry: { 'asia-east2': true } })
    expect(inEdgeCohort(strict, hostUnder(1000), 'asia-east2')).toBe(true)
  })
})

describe('edge control regional flags', () => {
  it('parses them, and keeps the object whole', () => {
    const flags = {
      mode: 'on',
      rolloutPermille: 10,
      leaveCeilingPermille: 100,
      regionRolloutPermille: { 'asia-east2': 100, 'us-central1': 10 },
      regionExcludeCountries: { 'asia-east2': ['CN'] },
      regionExcludeUnknownCountry: { 'asia-east2': false }
    }
    expect(parseEdgeControl({ v: 1, flags })).toEqual({ flags, ignoredKeys: [] })
  })

  it('voids a file whose leave ceiling is below any regional share', () => {
    expect(
      parseEdgeControl({ v: 1, flags: { mode: 'on', leaveCeilingPermille: 50, regionRolloutPermille: { 'asia-east2': 51 } } })
    ).toBeNull()
    expect(
      parseEdgeControl({ v: 1, flags: { mode: 'on', leaveCeilingPermille: 51, regionRolloutPermille: { 'asia-east2': 51 } } })
    ).not.toBeNull()
    // No ceiling: no constraint.
    expect(parseEdgeControl({ v: 1, flags: { mode: 'on', regionRolloutPermille: { 'asia-east2': 1000 } } })).not.toBeNull()
  })

  it('voids a malformed regional value as a whole', () => {
    for (const bad of [
      { regionRolloutPermille: { 'europe-west1': 10 } },
      { regionRolloutPermille: { 'asia-east2': 1001 } },
      { regionRolloutPermille: { 'asia-east2': 1.5 } },
      { regionRolloutPermille: ['asia-east2'] },
      { regionExcludeCountries: { 'asia-east2': ['cn'] } },
      { regionExcludeCountries: { 'asia-east2': 'CN' } },
      { regionExcludeCountries: { 'mars-north1': ['CN'] } },
      { regionExcludeUnknownCountry: { 'asia-east2': 'yes' } }
    ]) {
      expect(parseEdgeControl({ v: 1, flags: { mode: 'on', ...bad } })).toBeNull()
    }
  })
})

describe('edge move records the region', () => {
  const databases: RelayDatabase[] = []
  afterEach(async () => {
    for (const database of databases.splice(0)) await database.close()
  })
  const identity = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }

  async function recorded(database: RelayDatabase) {
    return (
      await database.query(
        `SELECT preferred_region, observed_at FROM relay_assignment_region_preferences
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).map((row) => ({ region: row.preferred_region, at: Number(row.observed_at) }))
  }

  it('on a first move, a kept host and a move off a cell; no region asked is the default region', async () => {
    const database = await openInMemoryRelayDatabase()
    databases.push(database)
    let now = 1_000
    const edge = new EdgeAssignments(database, config({ mode: 'on' }), () => now)
    await edge.ensureEdgeCell()
    await edge.moveToEdge(identity, 0, 'asia-east2')
    expect(await recorded(database)).toEqual([{ region: 'asia-east2', at: 1_000 }])
    now = 2_000
    await edge.moveToEdge(identity, 0)
    expect(await recorded(database)).toEqual([{ region: RELAY_DEFAULT_REGION, at: 2_000 }])
    // Off to a cell row, then moved back on.
    await database.query(`UPDATE relay_assignments SET cell_id = 'us-c1' WHERE user_id = ?`, [identity.userId])
    now = 3_000
    await edge.moveToEdge(identity, 0, 'asia-east2')
    expect(await recorded(database)).toEqual([{ region: 'asia-east2', at: 3_000 }])
  })

  it('records nothing for a move that does not commit', async () => {
    const database = await openInMemoryRelayDatabase()
    databases.push(database)
    const admin = {
      assign: vi.fn(async () => {
        throw new (await import('./edge-admin-client.js')).EdgeAdminUnavailableError('status_503')
      })
    } as unknown as EdgeAdmin
    const edge = new EdgeAssignments(database, config({ mode: 'on' }), () => 1_000, admin)
    await edge.ensureEdgeCell()
    await expect(edge.moveToEdge(identity, 0, 'asia-east2')).rejects.toBeInstanceOf(EdgeMoveDeferredError)
    expect(await recorded(database)).toEqual([])
  })
})

describe('edge evacuation by recorded region', () => {
  const databases: RelayDatabase[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const database of databases.splice(0)) await database.close()
  })

  async function harness(flags: EdgeControlFlags) {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const database = await openInMemoryRelayDatabase()
    databases.push(database)
    const drained: string[] = []
    const admin = {
      drain: async (relayHostId: string): Promise<EdgeDrainResult> => {
        drained.push(relayHostId)
        return { outcome: 'idle' }
      }
    } as unknown as EdgeAdmin
    const evacuation = new EdgeEvacuation(database, config(flags), admin, EDGE_CELL_ID, () => 1_000, () => 0)
    const onEdge = async (relayHostId: string, region?: RelayRegion) => {
      await database.query(
        `INSERT INTO relay_assignments
         (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at, last_activity_at,
          reserved_controls, reserved_splices, reserved_invites, pending_installs,
          pending_confirmations, migration_leases)
         VALUES ('user-1', ?, ?, 1, 0, 0, 0, 0, 0, 0, 0, 0)`,
        [relayHostId, EDGE_CELL_ID]
      )
      if (region) {
        await database.query(
          `INSERT INTO relay_assignment_region_preferences (user_id, relay_host_id, preferred_region, observed_at)
           VALUES ('user-1', ?, ?, 0)`,
          [relayHostId, region]
        )
      }
    }
    return { evacuation, drained, onEdge }
  }

  it('drains an aborted region by its recorded hosts, and keeps the rest', async () => {
    // Asia aborted (0), us-central1 at the global 1000: unrecorded hosts are judged at the max.
    const h = await harness({ mode: 'on', rolloutPermille: 1000, regionRolloutPermille: { 'asia-east2': 0 } })
    const [asia, us, unrecorded] = hosts.slice(10, 13)
    await h.onEdge(asia!, 'asia-east2')
    await h.onEdge(us!, 'us-central1')
    await h.onEdge(unrecorded!)
    await h.evacuation.sweep()
    expect(h.drained).toEqual([asia])
  })

  it("judges 'any' for a recorded region without its own share, as before", async () => {
    // us-central1 has no regional value: its hosts are judged at the max (asia's 1000), not drained.
    const h = await harness({ mode: 'on', rolloutPermille: 0, regionRolloutPermille: { 'asia-east2': 1000 } })
    await h.onEdge(hosts[20]!, 'us-central1')
    await h.onEdge(hosts[21]!)
    await h.evacuation.sweep()
    expect(h.drained).toEqual([])
  })

  it('without regional flags ignores recorded regions entirely', async () => {
    const h = await harness({ mode: 'on', rolloutPermille: 1000 })
    await h.onEdge(hosts[30]!, 'asia-east2')
    await h.evacuation.sweep()
    expect(h.drained).toEqual([])
  })
})

describe('edge region × country log', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('counts asks per requested region and country and logs nothing else', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tally = new EdgeRegionCountryTally()
    tally.flush()
    expect(warn).not.toHaveBeenCalled()
    tally.record('asia-east2', 'CN')
    tally.record('asia-east2', 'CN')
    tally.record('asia-east2', 'HK')
    tally.record('asia-east2', null)
    tally.record(undefined, 'US')
    tally.flush()
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      {
        event: EDGE_REGION_COUNTRY_EVENT,
        windowMs: 60_000,
        counts: { 'asia-east2': { CN: 2, HK: 1, unknown: 1 }, none: { US: 1 } }
      }
    ])
    tally.flush()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('flushes once a minute after start', () => {
    vi.useFakeTimers()
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const tally = new EdgeRegionCountryTally()
      tally.start()
      tally.record('asia-east2', 'HK')
      vi.advanceTimersByTime(60_000)
      expect(warn).toHaveBeenCalledTimes(1)
      tally.stop()
      tally.record('asia-east2', 'HK')
      vi.advanceTimersByTime(120_000)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
