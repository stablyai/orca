import { afterEach, describe, expect, it, vi } from 'vitest'
import { harness, closeHarnesses, expectRefused, expectBusy, expectNoIdentityLogged, type Harness } from './test-fixtures/edge-dormant-move-harness.js'
import { RETIRING, OTHER, HOST, IDENTITY, T0, TTL, INCARNATION } from './test-fixtures/edge-dormant-move-fixtures.js'
import { EDGE_CELL_ID } from './edge-relay.js'
import { ShadowSeatDirectory } from './shadow-seat-directory.js'
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

describe('on a reserve-mode cell', () => {
  it('moves past stale counters no live lease backs, as drain-stale does', async () => {
    const h = await harness(createRelayApp, { reserve: true })
    await h.placeRow(HOST, { invites: 28 })
    await h.addLease(T0)
    expect((await h.move()).status).toBe(200)
    expect(await h.row()).toMatchObject({ cell_id: EDGE_CELL_ID, reserved_invites: 0 })
    expect(h.logged('orca_relay_edge_moved')).toEqual([
      expect.objectContaining({ dormant: true, staleUnits: true })
    ])
    expect(h.logged('orca_relay_edge_dormant_move')).toEqual([
      { event: 'orca_relay_edge_dormant_move', outcome: 'moved', admitMode: 'reserve' }
    ])
    expectNoIdentityLogged(h)
  })

  it('refuses stale counters a live lease backs', async () => {
    const h = await harness(createRelayApp, { reserve: true })
    await h.placeRow(HOST, { invites: 28 })
    await h.addLease(T0 + 1)
    await expectRefused(h, await h.move(), 'lease_live')
  })

  it('still applies the dormant TTL to the row', async () => {
    const h = await harness(createRelayApp, { reserve: true })
    await h.placeRow(HOST, { invites: 28, lastActivityAt: T0 - TTL + 1 })
    await expectRefused(h, await h.move(), 'not_dormant')
  })

  it('answers 503 without a complete seat map, on either mode', async () => {
    for (const reserve of [true, false]) {
      const incomplete = await harness(createRelayApp, { reserve })
      await incomplete.placeRow()
      incomplete.shadowState.complete = false
      await expectBusy(incomplete, await incomplete.move(), 'seat_map_incomplete')
      const none = await harness(createRelayApp, { reserve, shadow: false })
      await none.placeRow()
      await expectBusy(none, await none.move(), 'seat_map_incomplete')
    }
  })

  it('refuses a host the seat map shows seated, or seen within the TTL', async () => {
    const h = await harness(createRelayApp, { reserve: true })
    await h.placeRow()
    h.shadowState.seated.add(HOST)
    await expectRefused(h, await h.move(), 'host_seated')
    h.shadowState.seated.clear()
    h.shadowState.recentlyLeftAt.set(HOST, Date.now() - 60_000)
    await expectRefused(h, await h.move(), 'host_recently_seated')
    expect((await h.row())?.cell_id).toBe(RETIRING.id)
  })

  it('lists rows with counters on a reserve-mode cell, and not on a database-mode one', async () => {
    const reserve = await harness(createRelayApp, { reserve: true })
    await reserve.placeRow(HOST, { invites: 3 })
    expect(await (await reserve.list({ cellId: RETIRING.id })).json()).toEqual({
      v: 1, admitMode: 'reserve', candidates: [IDENTITY], cursor: null
    })
    const db = await harness(createRelayApp)
    await db.placeRow(HOST, { invites: 3 })
    expect(await (await db.list({ cellId: RETIRING.id })).json()).toEqual({
      v: 1, admitMode: 'db', candidates: [], cursor: null
    })
  })
})

describe('the dormant move trusts only a fresh, caught-up feed from the source cell\'s process', () => {
  // The source is roll-isolated in these tests (not required for completeness), as a cell being
  // retired is: the map reads complete without the source ever having answered.
  function directory(): ShadowSeatDirectory {
    const map = new ShadowSeatDirectory()
    map.setCells([RETIRING.id, OTHER.id], [OTHER.id])
    map.apply(OTHER.id, { v: 1, cellId: OTHER.id, incarnation: 'other-cell', seq: 0, at: 0, full: [] }, Date.now())
    return map
  }
  function answer(
    map: ShadowSeatDirectory,
    polledAt: number,
    incarnation = INCARNATION,
    full: { userId: string; relayHostId: string; epoch: number; generation: number; state: string; joinedAt: number }[] = []
  ) {
    map.apply(RETIRING.id, { v: 1, cellId: RETIRING.id, incarnation, seq: 0, at: polledAt, full }, polledAt, polledAt)
  }
  async function expectFeedNotFresh(h: Harness, response: Response, cellId = RETIRING.id) {
    await expectBusy(h, response, 'feed_not_fresh')
    expect((await h.row())?.cell_id).toBe(cellId)
  }

  it('refuses, retryably, a source feed that never answered though the map reads complete', async () => {
    const map = directory()
    expect(map.isComplete()).toBe(true)
    const h = await harness(createRelayApp, { reserve: true, directory: map })
    await h.placeRow(HOST, { invites: 2 })
    await expectFeedNotFresh(h, await h.move())
  })

  it('refuses a source feed whose last poll left before the request', async () => {
    const map = directory()
    answer(map, Date.now() - 10_000)
    const h = await harness(createRelayApp, { reserve: true, directory: map })
    await h.placeRow()
    await expectFeedNotFresh(h, await h.move())
  })

  it('refuses a fresh feed from another process than the cell\'s runtime row', async () => {
    const map = directory()
    const h = await harness(createRelayApp, { reserve: true, directory: map })
    await h.placeRow()
    const pending = h.move()
    setTimeout(() => answer(map, Date.now(), 'an-older-process'), 30)
    await expectFeedNotFresh(h, await pending)
  })

  it('moves once a poll sent after the request shows the host absent', async () => {
    const map = directory()
    answer(map, Date.now() - 10_000)
    const h = await harness(createRelayApp, { reserve: true, directory: map })
    await h.placeRow(HOST, { invites: 2 })
    const pending = h.move()
    setTimeout(() => answer(map, Date.now()), 30)
    expect((await pending).status).toBe(200)
    expect((await h.row())?.cell_id).toBe(EDGE_CELL_ID)
  })

  it('refuses a host that poll shows seated', async () => {
    const map = directory()
    const h = await harness(createRelayApp, { reserve: true, directory: map })
    await h.placeRow()
    const pending = h.move()
    setTimeout(
      () => answer(map, Date.now(), INCARNATION, [{ ...IDENTITY, epoch: 4, generation: 1, state: 'active', joinedAt: 1 }]),
      30
    )
    await expectRefused(h, await pending, 'host_seated')
  })

  it('refuses each degraded feed state of the stub too, on either mode', async () => {
    for (const reserve of [true, false]) {
      for (const feed of ['pending', 'stale', 'mismatch', 'unverifiable', 'partial'] as const) {
        const h = await harness(createRelayApp, { reserve })
        await h.placeRow()
        h.shadowState.feed = feed
        await expectFeedNotFresh(h, await h.move())
      }
    }
  })

  it('refuses a source the map does not poll, or one with no runtime row', async () => {
    const h = await harness(createRelayApp)
    await h.placeRow(HOST, { cellId: OTHER.id })
    await expectFeedNotFresh(h, await h.move({ sourceCellId: OTHER.id }), OTHER.id)
    const map = directory()
    const gone = await harness(createRelayApp, { directory: map })
    await gone.placeRow()
    await gone.database.query(`DELETE FROM relay_cell_runtime WHERE cell_id = ?`, [RETIRING.id])
    const pending = gone.move()
    setTimeout(() => answer(map, Date.now()), 30)
    await expectFeedNotFresh(gone, await pending)
  })

  it('refuses a feed whose only poll since the request was a partial page', async () => {
    const map = directory()
    answer(map, Date.now() - 10_000)
    const h = await harness(createRelayApp, { directory: map })
    await h.placeRow()
    const pending = h.move()
    setTimeout(() => {
      const at = Date.now()
      map.apply(
        RETIRING.id,
        {
          v: 1, cellId: RETIRING.id, incarnation: INCARNATION, seq: 5, at, more: true,
          changes: [{ seq: 1, kind: 'leave', userId: 'someone-else', relayHostId: 'otherhost0000001', epoch: 1, generation: 1, at }]
        },
        at,
        at
      )
    }, 30)
    await expectFeedNotFresh(h, await pending)
  })

  it('re-judges the feed under the row lock: a new process mid-move refuses', async () => {
    const h = await harness(createRelayApp)
    await h.placeRow()
    // Read 1 is the check before the transaction: the cell restarts right after it.
    h.shadowState.onSeatsRead = (reads) => {
      if (reads === 1) { h.shadowState.feed = 'mismatch' }
    }
    await expectFeedNotFresh(h, await h.move())
  })
})
