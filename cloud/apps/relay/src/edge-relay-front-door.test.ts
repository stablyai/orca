import { afterEach, describe, expect, it, vi } from 'vitest'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'
import type { EdgeAdmin, EdgeAssignBody } from './edge-admin-client.js'
import { edgeLocationHint } from './edge-admin-client.js'
import { edgeFrontDoorFor, parseEdgeControl, parseEdgeControlOver, type EdgeControlFlags } from './edge-relay-control.js'
import {
  EDGE_CELL_ID,
  EDGE_LOCKED_CALLS_MAX,
  EdgeAssignments,
  EdgeMoveBusyError,
  EdgeMoveDeferredError,
  type EdgeRelayConfig
} from './edge-relay.js'
import { edgeRoute } from './edge-relay-route.js'
import { EdgeAdminUnavailableError } from './edge-admin-client.js'

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

  it('a bad frontDoor drops only that key (reported); the rest of the object applies', () => {
    for (const frontDoor of [
      { url: 'http://cn.relay.example.test' },
      { url: `${DOOR}/path` },
      { url: 'cn.relay.example.test' },
      { url: DOOR, countries: ['CHN'] },
      { url: DOOR, hosts: ['short'] },
      { url: DOOR, extra: true },
      { countries: ['CN'] },
      'yes',
      null
    ]) {
      expect(parse({ mode: 'off', regionExcludeCountries: { 'us-central1': ['cn'] }, frontDoor })).toEqual({
        flags: { mode: 'off', regionExcludeCountries: { 'us-central1': ['CN'] } },
        ignoredKeys: ['frontDoor']
      })
    }
    // Any other bad value still voids the whole object.
    expect(parse({ mode: 'sideways', frontDoor: { url: DOOR } })).toBeNull()
  })

  it('a bad frontDoor over a good one keeps the good one (reported), like a bad file keeps the last flags', () => {
    const previous: EdgeControlFlags = { mode: 'on', frontDoor: { url: DOOR, countries: ['CN'] } }
    expect(parseEdgeControlOver({ v: 1, flags: { mode: 'off', frontDoor: { url: 'http://typo' } } }, previous)).toEqual({
      flags: { mode: 'off', frontDoor: { url: DOOR, countries: ['CN'] } },
      ignoredKeys: ['frontDoor']
    })
    // Removing the key is not a bad value: the mapping goes.
    expect(parseEdgeControlOver({ v: 1, flags: { mode: 'on' } }, previous)).toEqual({ flags: { mode: 'on' }, ignoredKeys: [] })
    // A good value replaces it.
    expect(parseEdgeControlOver({ v: 1, flags: { frontDoor: { url: DOOR, hosts: [HOST] } } }, previous)?.flags.frontDoor).toEqual({
      url: DOOR,
      hosts: [HOST]
    })
  })

  it('a trailing slash on the URL is the same origin', () => {
    expect(parse({ frontDoor: { url: `${DOOR}/`, hosts: [HOST] } })?.flags.frontDoor).toEqual({ url: DOOR, hosts: [HOST] })
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
    expect(edgeFrontDoorFor(f, urls, OTHER, 'us-central1', 'CN')).toEqual({ url: DOOR, byCountry: true })
    expect(edgeFrontDoorFor(f, urls, OTHER, 'us-central1', 'US')).toBeUndefined()
    expect(edgeFrontDoorFor(f, urls, OTHER, 'us-central1', null)).toBeUndefined()
    // Listed by id: mapped anywhere, but not by country (so not placed in apac).
    expect(edgeFrontDoorFor(f, urls, HOST, 'us-central1', null)).toEqual({ url: DOOR, byCountry: false })
    expect(edgeFrontDoorFor(f, urls, HOST, 'us-central1', 'US')).toEqual({ url: DOOR, byCountry: false })
    expect(edgeFrontDoorFor(f, urls, HOST, 'us-central1', 'CN')).toEqual({ url: DOOR, byCountry: true })
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
    expect(edgeFrontDoorFor(f, urls, OTHER, 'asia-east2', 'CN')).toEqual({ url: DOOR, byCountry: true })
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

  async function setup(frontDoorUrls?: ReadonlySet<string>, fail?: { next: boolean }) {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const database = await openInMemoryRelayDatabase()
    databases.push(database)
    const pushes: EdgeAssignBody[] = []
    const admin = {
      assign: async (body: EdgeAssignBody) => {
        pushes.push(body)
        if (fail?.next) throw new EdgeAdminUnavailableError('status_503')
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
    const first = await edge.moveToEdge(identity, 0, 'us-central1', { frontDoor: DOOR, switchable: true })
    const again = await edge.moveToEdge(identity, 0, 'us-central1', { frontDoor: DOOR, switchable: true })
    expect([first.cellUrl, again.cellUrl]).toEqual([EDGE_URL, EDGE_URL])
    expect([first.assignmentEpoch, again.assignmentEpoch]).toEqual([1, 1])
    expect(pushes.map((p) => p.locationHint)).toEqual(['enam'])
    expect(await recordedUrl()).toBeNull()
    expect((await edge.edgeAssignment(identity))?.cellUrl).toBe(EDGE_URL)
  })

  it('a first move through the front door answers it, places the object in apac and records it for phones', async () => {
    const { edge, pushes, recordedUrl } = await setup(new Set([DOOR]))
    const moved = await edge.moveToEdge(identity, 3, 'us-central1', { frontDoor: DOOR, byCountry: true, switchable: false })
    expect(moved).toMatchObject({ cellId: EDGE_CELL_ID, cellUrl: DOOR, assignmentEpoch: 4 })
    expect(pushes).toHaveLength(1)
    expect(pushes[0]).toMatchObject({ assignmentEpoch: 4, locationHint: 'apac' })
    expect(pushes[0]!.devices).toEqual([])
    expect(await recordedUrl()).toBe(DOOR)
    expect(await edge.edgeAssignment(identity)).toMatchObject({ cellUrl: DOOR, assignmentEpoch: 4 })
  })

  it('a host already on the edge switches only on a reconnect ask, at a newer epoch, pushed without devices', async () => {
    const { edge, pushes, recordedUrl } = await setup(new Set([DOOR]))
    await edge.moveToEdge(identity, 0, 'us-central1', { switchable: false })
    expect(pushes).toHaveLength(1)
    // Mapped now, but not reconnecting: sticky, same epoch, no push.
    const kept = await edge.moveToEdge(identity, 0, 'us-central1', { frontDoor: DOOR, switchable: false })
    expect(kept).toMatchObject({ cellUrl: EDGE_URL, assignmentEpoch: 1 })
    expect(pushes).toHaveLength(1)
    // Reconnecting: switch.
    const switched = await edge.moveToEdge(identity, 0, 'us-central1', { frontDoor: DOOR, switchable: true })
    expect(switched).toMatchObject({ cellUrl: DOOR, assignmentEpoch: 2 })
    expect(pushes).toHaveLength(2)
    expect(pushes[1]).toMatchObject({ assignmentEpoch: 2, cellId: EDGE_CELL_ID })
    expect('devices' in pushes[1]!).toBe(false)
    expect(await recordedUrl()).toBe(DOOR)
    // Re-asks keep it, with no further epoch.
    const again = await edge.moveToEdge(identity, 0, 'us-central1', { frontDoor: DOOR, switchable: true })
    expect(again).toMatchObject({ cellUrl: DOOR, assignmentEpoch: 2 })
    expect(pushes).toHaveLength(2)
    // Flag removed (rollback): kept until the next reconnect, then back to the edge at a newer epoch.
    expect(await edge.moveToEdge(identity, 0, 'us-central1', { switchable: false })).toMatchObject({ cellUrl: DOOR, assignmentEpoch: 2 })
    expect(await edge.moveToEdge(identity, 0, 'us-central1', { switchable: true })).toMatchObject({ cellUrl: EDGE_URL, assignmentEpoch: 3 })
    expect(await recordedUrl()).toBeNull()
    expect((await edge.edgeAssignment(identity))?.cellUrl).toBe(EDGE_URL)
  })

  it('a recorded front door dropped from the boot list is answered as the edge URL', async () => {
    const { database, edge } = await setup(new Set([DOOR]))
    await edge.moveToEdge(identity, 0, 'us-central1', { frontDoor: DOOR, switchable: false })
    await database.query(`UPDATE relay_edge_host_regions SET cell_url = 'https://gone.relay.example.test'`)
    expect((await edge.edgeAssignment(identity))?.cellUrl).toBe(EDGE_URL)
    expect(await edge.moveToEdge(identity, 0, 'us-central1', { switchable: false })).toMatchObject({ cellUrl: EDGE_URL, assignmentEpoch: 1 })
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
    expect(await edge.moveToEdge(identity, 0, 'us-central1', { frontDoor: DOOR, switchable: false })).toMatchObject({
      cellUrl: DOOR,
      assignmentEpoch: 8
    })
    expect(pushes[0]!.devices).toEqual([])
    expect(await recordedUrl()).toBe(DOOR)
  })

  it('an older director (no route argument) keeps answering the edge URL and leaves the record alone', async () => {
    const { edge, recordedUrl } = await setup(new Set([DOOR]))
    await edge.moveToEdge(identity, 0, 'us-central1', { frontDoor: DOOR, switchable: false })
    // The pre-front-door path: same epoch, its own URL, record untouched.
    expect(await edge.moveToEdge(identity, 0, 'us-central1')).toMatchObject({ cellUrl: EDGE_URL, assignmentEpoch: 1 })
    expect(await recordedUrl()).toBe(DOOR)
  })

  it('a host listed only by id keeps the location hint of its region', async () => {
    const { edge, pushes } = await setup(new Set([DOOR]))
    await edge.moveToEdge(identity, 0, 'us-central1', { frontDoor: DOOR, byCountry: false, switchable: false })
    expect(pushes[0]!.locationHint).toBe('enam')
  })

  it('a switch push that times out after landing answers busy, and the retry commits the landed epoch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const database = await openInMemoryRelayDatabase()
    databases.push(database)
    // A fake edge object: epochs only move forward; `landThenFail` applies the push, then the
    // director sees a timeout.
    const edgeState = { epoch: 0, landThenFail: false, down: false }
    const pushes: EdgeAssignBody[] = []
    const admin = {
      assign: async (body: EdgeAssignBody) => {
        pushes.push(body)
        if (edgeState.down) throw new EdgeAdminUnavailableError('timeout')
        if (body.assignmentEpoch < edgeState.epoch) return { outcome: 'stale' as const, assignmentEpoch: edgeState.epoch }
        const outcome = body.assignmentEpoch === edgeState.epoch ? ('unchanged' as const) : ('applied' as const)
        edgeState.epoch = body.assignmentEpoch
        if (edgeState.landThenFail) throw new EdgeAdminUnavailableError('timeout')
        return { outcome, assignmentEpoch: body.assignmentEpoch }
      }
    } as unknown as EdgeAdmin
    const edge = new EdgeAssignments(
      database,
      { cellUrl: EDGE_URL, frontDoorUrls: new Set([DOOR]), rolloutPercent: 0, allowHosts: new Set(), denyHosts: new Set(), regions: new Set(['us-central1']) },
      () => 1_000,
      admin
    )
    await edge.ensureEdgeCell()
    await edge.moveToEdge(identity, 0, 'us-central1', { switchable: false })
    expect(edgeState.epoch).toBe(1)
    edgeState.landThenFail = true
    await expect(edge.moveToEdge(identity, 0, 'us-central1', { frontDoor: DOOR, switchable: true })).rejects.toBeInstanceOf(
      EdgeMoveBusyError
    )
    // The edge holds 2; the director row is still 1 and never answered 1 after the push was sent.
    expect(edgeState.epoch).toBe(2)
    const row = (await database.query(`SELECT cell_id, assignment_epoch FROM relay_assignments`))[0]!
    expect([row.cell_id, Number(row.assignment_epoch)]).toEqual([EDGE_CELL_ID, 1])
    // Still unreachable: still busy, never an answer at an epoch the edge may be past.
    edgeState.down = true
    await expect(edge.moveToEdge(identity, 0, 'us-central1', { frontDoor: DOOR, switchable: true })).rejects.toBeInstanceOf(
      EdgeMoveBusyError
    )
    // Back: the retry pushes the same epoch, the edge answers unchanged, and 2 commits.
    edgeState.down = false
    edgeState.landThenFail = false
    expect(await edge.moveToEdge(identity, 0, 'us-central1', { frontDoor: DOOR, switchable: true })).toMatchObject({
      cellUrl: DOOR,
      assignmentEpoch: 2
    })
    expect(edgeState.epoch).toBe(2)
    // A first move whose push fails is still deferred as before (the host is not on the edge yet).
    await database.query(`DELETE FROM relay_assignments`)
    edgeState.down = true
    await expect(edge.moveToEdge(identity, 0, 'us-central1', { frontDoor: DOOR, switchable: true })).rejects.toBeInstanceOf(
      EdgeMoveDeferredError
    )
  })

  it('a switch this director could not even send (push cap) keeps the host unswitched at its epoch', async () => {
    const { database, edge, pushes } = await setup(new Set([DOOR]))
    await edge.moveToEdge(identity, 0, 'us-central1', { switchable: false })
    ;(edge as unknown as { lockedCalls: number }).lockedCalls = EDGE_LOCKED_CALLS_MAX
    expect(await edge.moveToEdge(identity, 0, 'us-central1', { frontDoor: DOOR, switchable: true })).toMatchObject({
      cellId: EDGE_CELL_ID,
      cellUrl: EDGE_URL,
      assignmentEpoch: 1
    })
    expect(pushes).toHaveLength(1)
    const row = (await database.query(`SELECT assignment_epoch FROM relay_assignments`))[0]!
    expect(Number(row.assignment_epoch)).toBe(1)
  })

  it('a recorded front door dropped from the boot list causes no epoch bump, and the record is cleared', async () => {
    const { database, edge, pushes, recordedUrl } = await setup(new Set([DOOR]))
    await edge.moveToEdge(identity, 0, 'us-central1', { frontDoor: DOOR, switchable: false })
    await database.query(`UPDATE relay_edge_host_regions SET cell_url = 'https://gone.relay.example.test'`)
    expect(await edge.moveToEdge(identity, 0, 'us-central1', { switchable: true })).toMatchObject({
      cellUrl: EDGE_URL,
      assignmentEpoch: 1
    })
    expect(pushes).toHaveLength(1)
    expect(await recordedUrl()).toBeNull()
  })
})

describe('edgeRoute (which asks may switch)', () => {
  const base: EdgeRelayConfig = {
    cellUrl: EDGE_URL,
    rolloutPercent: 0,
    allowHosts: new Set(),
    denyHosts: new Set(),
    regions: new Set(['us-central1']),
    control: () => ({ mode: 'on', frontDoor: { url: DOOR, countries: ['CN'] } })
  }

  it('is absent without the boot list', () => {
    expect(edgeRoute(base, HOST, 'us-central1', 'CN', { reconnect: true })).toBeUndefined()
  })

  it('switches only on reconnect without regionCorrection (the desktop drain path)', () => {
    const config = { ...base, frontDoorUrls: new Set([DOOR]) }
    expect(edgeRoute(config, HOST, 'us-central1', 'CN', { reconnect: true })).toEqual({
      frontDoor: DOOR,
      byCountry: true,
      switchable: true
    })
    // The hourly region refresh (and the initial open), both issue-window while connected.
    expect(edgeRoute(config, HOST, 'us-central1', 'CN', { reconnect: true, regionCorrection: { v: 1, action: 'issue-window' } })?.switchable).toBe(false)
    expect(edgeRoute(config, HOST, 'us-central1', 'CN', {})?.switchable).toBe(false)
    expect(edgeRoute(config, HOST, 'us-central1', 'US', { reconnect: true })).toEqual({ switchable: true })
    // No region asked: the default region's exclusion applies.
    const excluded = {
      ...config,
      control: () => ({ mode: 'on' as const, frontDoor: { url: DOOR, countries: ['CN'] }, regionExcludeCountries: { 'us-central1': ['CN'] } })
    }
    expect(edgeRoute(excluded, HOST, undefined, 'CN', { reconnect: true })).toEqual({ switchable: true })
  })
})
