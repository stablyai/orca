import { afterEach, describe, expect, it, vi } from 'vitest'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'
import type { EdgeAdmin, EdgeAssignBody } from './edge-admin-client.js'
import { edgeLocationHint } from './edge-admin-client.js'
import { edgeFrontDoorFor, parseEdgeControl, type EdgeControlFlags } from './edge-relay-control.js'
import { EDGE_CELL_ID, EdgeAssignments, type EdgeRelayConfig } from './edge-relay.js'

const EDGE_URL = 'https://edge.relay.example.test'
const DOOR = 'https://cn.relay.example.test'
const HOST = 'abcdefghijklmnop'
const OTHER = 'qrstuvwxyzABCDEF'

describe('director/edge.json frontDoor', () => {
  const parse = (flags: unknown) => parseEdgeControl({ v: 1, flags })

  it('parses a front door; countries are upper-cased like the exclusion lists', () => {
    expect(parse({ frontDoor: { url: DOOR, countries: ['cn'], hosts: [HOST] } })?.flags).toEqual({
      mode: 'on',
      frontDoor: { url: DOOR, countries: ['CN'], hosts: [HOST] }
    })
  })

  it('absent: the parsed flags have no frontDoor key at all', () => {
    expect(parse({ mode: 'on', rolloutPermille: 5 })?.flags).toEqual({ mode: 'on', rolloutPermille: 5 })
  })

  it('a bad value voids the whole object', () => {
    for (const frontDoor of [
      { url: 'http://cn.relay.example.test' },
      { url: `${DOOR}/path` },
      { url: 'cn.relay.example.test' },
      { url: DOOR, countries: ['CHN'] },
      { url: DOOR, hosts: ['short'] },
      { url: DOOR, extra: true },
      { countries: ['CN'] },
      'yes'
    ]) {
      expect(parse({ mode: 'on', frontDoor })).toBeNull()
    }
  })

  it('an image without the key ignores it (reported as unknown), which keeps image rollback safe', () => {
    // What an older director does with the key: drop it, keep every other flag.
    const body = { v: 1, flags: { mode: 'on', rolloutPermille: 5, laterKey: { url: DOOR } } }
    expect(parseEdgeControl(body)).toEqual({ flags: { mode: 'on', rolloutPermille: 5 }, ignoredKeys: ['laterKey'] })
  })
})

describe('edgeFrontDoorFor', () => {
  const urls = new Set([DOOR])
  const flags = (frontDoor?: EdgeControlFlags['frontDoor'], extra: Partial<EdgeControlFlags> = {}): EdgeControlFlags => ({
    mode: 'on',
    ...(frontDoor ? { frontDoor } : {}),
    ...extra
  })

  it('maps by ask country or by host id; an unknown country only by host id', () => {
    const f = flags({ url: DOOR, countries: ['CN'], hosts: [HOST] })
    expect(edgeFrontDoorFor(f, urls, OTHER, 'us-central1', 'CN')).toBe(DOOR)
    expect(edgeFrontDoorFor(f, urls, OTHER, 'us-central1', 'US')).toBeUndefined()
    expect(edgeFrontDoorFor(f, urls, OTHER, 'us-central1', null)).toBeUndefined()
    expect(edgeFrontDoorFor(f, urls, HOST, 'us-central1', null)).toBe(DOOR)
    expect(edgeFrontDoorFor(f, urls, HOST, 'us-central1', 'US')).toBe(DOOR)
  })

  it('maps nobody without the flag, without the boot list, or for a URL not on it', () => {
    expect(edgeFrontDoorFor(flags(), urls, HOST, 'us-central1', 'CN')).toBeUndefined()
    const f = flags({ url: DOOR, countries: ['CN'], hosts: [HOST] })
    expect(edgeFrontDoorFor(f, undefined, HOST, 'us-central1', 'CN')).toBeUndefined()
    expect(edgeFrontDoorFor(f, new Set(['https://other.relay.example.test']), HOST, 'us-central1', 'CN')).toBeUndefined()
  })

  it('a region country exclusion wins over both the country and the host list', () => {
    const f = flags({ url: DOOR, countries: ['CN'], hosts: [HOST] }, { regionExcludeCountries: { 'us-central1': ['CN'] } })
    expect(edgeFrontDoorFor(f, urls, OTHER, 'us-central1', 'CN')).toBeUndefined()
    expect(edgeFrontDoorFor(f, urls, HOST, 'us-central1', 'CN')).toBeUndefined()
    // Another region's exclusion does not apply.
    expect(edgeFrontDoorFor(f, urls, OTHER, 'asia-east2', 'CN')).toBe(DOOR)
    // Excluding unknown countries keeps an unknown-country listed host off the front door too.
    const unknown = flags({ url: DOOR, hosts: [HOST] }, { regionExcludeUnknownCountry: { 'us-central1': true } })
    expect(edgeFrontDoorFor(unknown, urls, HOST, 'us-central1', null)).toBeUndefined()
  })

  it('the location hint is apac through a front door, else unchanged', () => {
    expect(edgeLocationHint('us-central1', true)).toBe('apac')
    expect(edgeLocationHint('us-central1')).toBe('enam')
    expect(edgeLocationHint('asia-east2')).toBe('apac')
    expect(edgeLocationHint(undefined)).toBe('enam')
  })
})

describe('EdgeAssignments with front doors', () => {
  const databases: RelayDatabase[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const database of databases.splice(0)) await database.close()
  })
  const identity = { userId: 'user-1', relayHostId: HOST }

  async function setup(frontDoorUrls?: ReadonlySet<string>) {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const database = await openInMemoryRelayDatabase()
    databases.push(database)
    const pushes: EdgeAssignBody[] = []
    const admin = {
      assign: async (body: EdgeAssignBody) => {
        pushes.push(body)
        return { outcome: 'applied' as const, assignmentEpoch: body.assignmentEpoch }
      }
    } as unknown as EdgeAdmin
    const config: EdgeRelayConfig = {
      cellUrl: EDGE_URL,
      rolloutPercent: 0,
      allowHosts: new Set(),
      denyHosts: new Set(),
      regions: new Set(['us-central1']),
      control: () => ({ mode: 'on' }),
      ...(frontDoorUrls ? { frontDoorUrls } : {})
    }
    const edge = new EdgeAssignments(database, config, () => 1_000, admin)
    await edge.ensureEdgeCell()
    const recordedUrl = async () =>
      (await database.query(`SELECT cell_url FROM relay_edge_host_regions WHERE relay_host_id = ?`, [HOST]))[0]?.cell_url
    return { database, edge, pushes, recordedUrl }
  }

  it('no boot list: answers, pushes and records exactly as before, whatever the route says', async () => {
    const { edge, pushes, recordedUrl } = await setup()
    const first = await edge.moveToEdge(identity, 0, 'us-central1', { frontDoor: DOOR, reconnect: true })
    const again = await edge.moveToEdge(identity, 0, 'us-central1', { frontDoor: DOOR, reconnect: true })
    expect([first.cellUrl, again.cellUrl]).toEqual([EDGE_URL, EDGE_URL])
    expect([first.assignmentEpoch, again.assignmentEpoch]).toEqual([1, 1])
    expect(pushes.map((p) => p.locationHint)).toEqual(['enam'])
    expect(await recordedUrl()).toBeNull()
    expect((await edge.edgeAssignment(identity))?.cellUrl).toBe(EDGE_URL)
  })

  it('a first move through the front door answers it, places the object in apac and records it for phones', async () => {
    const { edge, pushes, recordedUrl } = await setup(new Set([DOOR]))
    const moved = await edge.moveToEdge(identity, 3, 'us-central1', { frontDoor: DOOR, reconnect: false })
    expect(moved).toMatchObject({ cellId: EDGE_CELL_ID, cellUrl: DOOR, assignmentEpoch: 4 })
    expect(pushes).toHaveLength(1)
    expect(pushes[0]).toMatchObject({ assignmentEpoch: 4, locationHint: 'apac' })
    expect(pushes[0]!.devices).toEqual([])
    expect(await recordedUrl()).toBe(DOOR)
    expect(await edge.edgeAssignment(identity)).toMatchObject({ cellUrl: DOOR, assignmentEpoch: 4 })
  })

  it('a host already on the edge switches only on a reconnect ask, at a newer epoch, pushed without devices', async () => {
    const { edge, pushes, recordedUrl } = await setup(new Set([DOOR]))
    await edge.moveToEdge(identity, 0, 'us-central1', { reconnect: false })
    expect(pushes).toHaveLength(1)
    // Mapped now, but not reconnecting: sticky, same epoch, no push.
    const kept = await edge.moveToEdge(identity, 0, 'us-central1', { frontDoor: DOOR, reconnect: false })
    expect(kept).toMatchObject({ cellUrl: EDGE_URL, assignmentEpoch: 1 })
    expect(pushes).toHaveLength(1)
    // Reconnecting: switch.
    const switched = await edge.moveToEdge(identity, 0, 'us-central1', { frontDoor: DOOR, reconnect: true })
    expect(switched).toMatchObject({ cellUrl: DOOR, assignmentEpoch: 2 })
    expect(pushes).toHaveLength(2)
    expect(pushes[1]).toMatchObject({ assignmentEpoch: 2, cellId: EDGE_CELL_ID })
    expect('devices' in pushes[1]!).toBe(false)
    expect(await recordedUrl()).toBe(DOOR)
    // Re-asks keep it, with no further epoch.
    const again = await edge.moveToEdge(identity, 0, 'us-central1', { frontDoor: DOOR, reconnect: true })
    expect(again).toMatchObject({ cellUrl: DOOR, assignmentEpoch: 2 })
    expect(pushes).toHaveLength(2)
    // Flag removed (rollback): kept until the next reconnect, then back to the edge at a newer epoch.
    expect(await edge.moveToEdge(identity, 0, 'us-central1', { reconnect: false })).toMatchObject({ cellUrl: DOOR, assignmentEpoch: 2 })
    expect(await edge.moveToEdge(identity, 0, 'us-central1', { reconnect: true })).toMatchObject({ cellUrl: EDGE_URL, assignmentEpoch: 3 })
    expect(await recordedUrl()).toBeNull()
    expect((await edge.edgeAssignment(identity))?.cellUrl).toBe(EDGE_URL)
  })

  it('a recorded front door dropped from the boot list is answered as the edge URL', async () => {
    const { database, edge } = await setup(new Set([DOOR]))
    await edge.moveToEdge(identity, 0, 'us-central1', { frontDoor: DOOR, reconnect: false })
    await database.query(`UPDATE relay_edge_host_regions SET cell_url = 'https://gone.relay.example.test'`)
    expect((await edge.edgeAssignment(identity))?.cellUrl).toBe(EDGE_URL)
    expect(await edge.moveToEdge(identity, 0, 'us-central1', { reconnect: false })).toMatchObject({ cellUrl: EDGE_URL, assignmentEpoch: 1 })
  })

  it('a move off a cell through the front door mints above the cell epoch and records it', async () => {
    const { database, edge, pushes, recordedUrl } = await setup(new Set([DOOR]))
    await database.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at, last_activity_at,
        reserved_controls, reserved_splices, reserved_invites, pending_installs, pending_confirmations, migration_leases)
       VALUES (?, ?, 'us-c1', 7, 0, 0, 0, 0, 0, 0, 0, 0)`,
      [identity.userId, identity.relayHostId]
    )
    expect(await edge.moveToEdge(identity, 0, 'us-central1', { frontDoor: DOOR, reconnect: false })).toMatchObject({
      cellUrl: DOOR,
      assignmentEpoch: 8
    })
    expect(pushes[0]!.devices).toEqual([])
    expect(await recordedUrl()).toBe(DOOR)
  })

  it('an older director (no route argument) keeps answering the edge URL and leaves the record alone', async () => {
    const { edge, recordedUrl } = await setup(new Set([DOOR]))
    await edge.moveToEdge(identity, 0, 'us-central1', { frontDoor: DOOR, reconnect: false })
    // The pre-front-door path: same epoch, its own URL, record untouched.
    expect(await edge.moveToEdge(identity, 0, 'us-central1')).toMatchObject({ cellUrl: EDGE_URL, assignmentEpoch: 1 })
    expect(await recordedUrl()).toBe(DOOR)
  })
})
