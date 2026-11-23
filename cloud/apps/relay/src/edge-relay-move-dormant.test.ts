import { afterEach, describe, expect, it, vi } from 'vitest'
import { harness, closeHarnesses, expectRefused, expectNoIdentityLogged, type HarnessOptions } from './test-fixtures/edge-dormant-move-harness.js'
import { RETIRING, OTHER, USER, HOST, SECOND_HOST, IDENTITY, T0, TTL } from './test-fixtures/edge-dormant-move-fixtures.js'
import { EDGE_CELL_ID, EDGE_MOVE_BUSY_RETRY_AFTER_SECONDS, EdgeMoveBusyError } from './edge-relay.js'
vi.mock('./admin-token-verifier.js', () => ({
  createAdminTokenVerifier: () => async (token: string) => token === 'deploy-token',
  createReadOnlyAdminTokenVerifier: () => async () => false,
  createRegionalRehomeControlApplyTokenVerifier: () => async () => false,
  createRegionalRehomeRuntimeTokenVerifier: () => async () => false,
  createRegionalRehomeTokenVerifier: () => async () => false,
  createRuntimeTokenVerifier: () => async () => false
}))

// A host's own relay token, for its next /v1/assign: `host:<relayHostId>` (always the test user).
vi.mock('./relay-token-verifier.js', () => ({
  createRelayTokenVerifier: () => async (token: string) =>
    token.startsWith('host:') ? { sub: 'user-dormant-1', relayHostId: token.slice('host:'.length) } : null,
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

import { createRelayApp } from './app.js'

afterEach(closeHarnesses)

describe('POST /v1/admin/edge-move-dormant', () => {
  it('moves a dormant host on a database-mode cell through the edge move path', async () => {
    const h = await harness(createRelayApp)
    await h.placeRow()
    const response = await h.move()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ v: 1, moved: true, assignmentEpoch: 5 })
    expect(await h.row()).toMatchObject({ cell_id: EDGE_CELL_ID, assignment_epoch: 5 })
    expect(h.pushes).toEqual([expect.objectContaining({ ...IDENTITY, cellId: EDGE_CELL_ID, assignmentEpoch: 5 })])
    expect(h.raiseEpochFloor).toHaveBeenCalledWith(IDENTITY, 5)
    // The region the host is recorded for: its cell's, with no asked-for one on record.
    const region = (await h.database.query(`SELECT region FROM relay_edge_host_regions`))[0]
    expect(region).toMatchObject({ region: 'us-central1' })
    expect(h.logged('orca_relay_edge_moved')).toEqual([
      { event: 'orca_relay_edge_moved', fromCellId: RETIRING.id, assignmentEpoch: 5, dormant: true }
    ])
    expect(h.logged('orca_relay_edge_dormant_move')).toEqual([
      { event: 'orca_relay_edge_dormant_move', outcome: 'moved', admitMode: 'db' }
    ])
    expectNoIdentityLogged(h)
  })

  it('records the host\'s asked-for region and clears a front door left from an earlier stay', async () => {
    const h = await harness(createRelayApp)
    await h.placeRow()
    await h.database.query(
      `INSERT INTO relay_assignment_region_preferences (user_id, relay_host_id, preferred_region, observed_at)
       VALUES (?, ?, 'asia-east2', 0)`,
      [USER, HOST]
    )
    await h.database.query(
      `INSERT INTO relay_edge_host_regions (user_id, relay_host_id, region, recorded_at, cell_url, pending_epoch)
       VALUES (?, ?, 'us-central1', 0, 'https://door.relay.example.test', 3)`,
      [USER, HOST]
    )
    expect((await h.move()).status).toBe(200)
    expect((await h.database.query(`SELECT region, cell_url, pending_epoch FROM relay_edge_host_regions`))[0]).toEqual({
      region: 'asia-east2',
      cell_url: null,
      pending_epoch: null
    })
    // The host is listed by id (allowHosts), so the cohort takes it whatever its region.
    expect(h.pushes[0]?.locationHint).toBe('apac')
  })

  it('releases the old cell\'s connection reservations at the old epoch, as rebalance-dormant does', async () => {
    const h = await harness(createRelayApp)
    await h.placeRow()
    await h.database.query(
      `INSERT INTO relay_control_connection_reservations
       (reservation_id, idempotency_key, user_id, relay_host_id, assignment_epoch, cell_id, state,
        created_at, timeout_at, updated_at)
       VALUES ('reservation-1', 'idempotency-1', ?, ?, 4, ?, 'reserved', 0, 0, 0)`,
      [USER, HOST, RETIRING.id]
    )
    const reserved = `SELECT 1 FROM relay_control_connection_reservations WHERE cell_id = ? AND state <> 'released'`
    expect(await h.database.query(reserved, [RETIRING.id])).toHaveLength(1)
    expect((await h.move()).status).toBe(200)
    expect(await h.database.query(reserved, [RETIRING.id])).toHaveLength(0)
  })

  it('takes the dormant TTL boundary from rebalance-dormant: one ms short refuses, exactly the TTL moves', async () => {
    const h = await harness(createRelayApp)
    await h.placeRow(HOST, { lastActivityAt: T0 - TTL + 1 })
    await expectRefused(h, await h.move(), 'not_dormant')
    expect((await h.row())?.cell_id).toBe(RETIRING.id)
    h.clock.now += 1
    expect((await h.move()).status).toBe(200)
    expect((await h.row())?.cell_id).toBe(EDGE_CELL_ID)
  })

  it('lists only rows past the same boundary', async () => {
    const h = await harness(createRelayApp)
    await h.placeRow(HOST, { lastActivityAt: T0 - TTL })
    await h.placeRow(SECOND_HOST, { lastActivityAt: T0 - TTL + 1 })
    const body = (await (await h.list({ cellId: RETIRING.id })).json()) as { candidates: unknown[] }
    expect(body.candidates).toEqual([IDENTITY])
  })

  it('refuses a row found on another cell than the expected source', async () => {
    const h = await harness(createRelayApp)
    await h.placeRow(HOST, { cellId: OTHER.id })
    await expectRefused(h, await h.move(), 'source_mismatch')
    expect((await h.row())?.cell_id).toBe(OTHER.id)
  })

  it('refuses a host with no row, and inserts none', async () => {
    const h = await harness(createRelayApp)
    await expectRefused(h, await h.move(), 'assignment_not_found')
    expect(await h.row()).toBeUndefined()
  })

  it('refuses a host already on the edge without refreshing its row', async () => {
    const h = await harness(createRelayApp)
    await h.placeRow()
    expect((await h.move()).status).toBe(200)
    const before = await h.row()
    h.pushes.length = 0
    h.clock.now += 1_000
    await expectRefused(h, await h.move(), 'already_on_edge')
    expect(await h.row()).toEqual(before)
  })

  it('refuses counters on a database-mode cell, where they are the truth', async () => {
    const h = await harness(createRelayApp)
    await h.placeRow(HOST, { invites: 2 })
    await expectRefused(h, await h.move(), 'units_held')
    expect(await h.row()).toMatchObject({ cell_id: RETIRING.id, reserved_invites: 2 })
  })

  it('refuses a live lease and moves past an expired one', async () => {
    const h = await harness(createRelayApp)
    await h.placeRow()
    await h.addLease(T0 + 1)
    await expectRefused(h, await h.move(), 'lease_live')
    await h.database.query(`UPDATE relay_assignment_activity_leases SET expires_at = ?`, [T0])
    expect((await h.move()).status).toBe(200)
  })

  it('refuses while a migration or region rehome is open', async () => {
    const h = await harness(createRelayApp)
    await h.placeRow()
    await h.database.query(
      `INSERT INTO relay_assignment_migrations
       (user_id, relay_host_id, source_cell_id, target_cell_id, previous_epoch, assignment_epoch,
        source_request_units, target_reserved_units, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 4, 5, 0, 1, ?, 0, 0)`,
      [USER, HOST, RETIRING.id, OTHER.id, T0 + 60_000]
    )
    await expectRefused(h, await h.move(), 'migration_open')
    expect((await h.row())?.cell_id).toBe(RETIRING.id)
  })


  it('refuses before any row read when the edge is not configured, ready or on, or the host is not the cohort\'s', async () => {
    const cases: [HarnessOptions, string][] = [
      [{ configured: false }, 'edge_not_configured'],
      [{ seeded: false }, 'edge_not_ready'],
      [{ control: () => ({ mode: 'off' }) }, 'edge_mode_not_on'],
      [{ control: () => ({ mode: 'down' }) }, 'edge_mode_not_on'],
      [{ denyHosts: [HOST] }, 'host_denied'],
      [{ allowHosts: [] }, 'not_in_cohort']
    ]
    for (const [options, reason] of cases) {
      const h = await harness(createRelayApp, options)
      await h.placeRow()
      await expectRefused(h, await h.move(), reason)
      expect((await h.row())?.cell_id).toBe(RETIRING.id)
    }
  })

  it('answers 503 with Retry-After when the director\'s locked pushes are at the cap, never waiting', async () => {
    const h = await harness(createRelayApp, { hang: true, lockedCallsMax: 1 })
    await h.placeRow(HOST)
    await h.placeRow(SECOND_HOST)
    const held = h.move()
    await vi.waitFor(() => expect(h.pushes).toHaveLength(1))
    const busy = await h.move({ relayHostId: SECOND_HOST })
    expect(busy.status).toBe(503)
    expect(busy.headers.get('Retry-After')).toBe(String(EDGE_MOVE_BUSY_RETRY_AFTER_SECONDS))
    expect(await busy.json()).toEqual({ error: 'relay_edge_move_busy', reason: 'edge_busy' })
    expect(h.logged('orca_relay_edge_dormant_move').at(-1)).toMatchObject({ outcome: 'busy', reason: 'edge_busy' })
    // Nothing was sent for the busy host. (Its row write rolls back with the transaction on a real
    // database; the inline transactions here cannot roll back, so the row is not checked.)
    expect(h.pushes).toHaveLength(1)
    h.release()
    expect((await held).status).toBe(200)
    expectNoIdentityLogged(h)
  })

  it('answers 503 with Retry-After when another director holds the row', async () => {
    const h = await harness(createRelayApp)
    await h.placeRow()
    vi.spyOn(h.edge, 'moveDormantToEdge').mockRejectedValue(new EdgeMoveBusyError())
    const response = await h.move()
    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe(String(EDGE_MOVE_BUSY_RETRY_AFTER_SECONDS))
    expect(await response.json()).toEqual({ error: 'relay_edge_move_busy', reason: 'relay_edge_move_busy' })
  })

  it('keeps rebalance-dormant\'s admin token, size and strict schema rules', async () => {
    const h = await harness(createRelayApp)
    expect((await h.move({}, 'other-token')).status).toBe(401)
    expect((await h.move({ extra: true })).status).toBe(400)
    expect((await h.move({ relayHostId: 'short' })).status).toBe(400)
    expect((await h.move({ sourceCellId: EDGE_CELL_ID })).status).toBe(400)
    expect((await h.move({ userId: 'u'.repeat(300_000) })).status).toBe(413)
  })
})
