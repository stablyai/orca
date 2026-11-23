import { afterEach, describe, expect, it, vi } from 'vitest'
import { harness, closeHarnesses, expectRefused, expectBusy } from './test-fixtures/edge-dormant-move-harness.js'
import { EDGE_URL, RETIRING, OTHER, USER, HOST, TTL } from './test-fixtures/edge-dormant-move-fixtures.js'
import { EDGE_CELL_ID, edgeCohortBucketPermille, inEdgeCohort, mayBeOnEdge, type EdgeRelayConfig } from './edge-relay.js'
import type { EdgeControlFlags } from './edge-relay-control.js'
import { parseIpCountryTable } from './ip-country.js'
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

describe('the dormant move re-reads the seat map under the row lock and after the push', () => {
  it('refuses a recent booking on any cell', async () => {
    const h = await harness(createRelayApp, { reserve: true })
    await h.placeRow()
    h.shadowState.booking = { cellId: RETIRING.id, epoch: 9, at: Date.now() - 60_000 }
    await expectRefused(h, await h.move(), 'host_booked')
  })

  it('mints above an old booking\'s epoch (the seat map floor)', async () => {
    const h = await harness(createRelayApp)
    await h.placeRow()
    h.shadowState.booking = { cellId: OTHER.id, epoch: 50, at: Date.now() - TTL - 60_000 }
    const response = await h.move()
    expect(await response.json()).toEqual({ v: 1, moved: true, assignmentEpoch: 51 })
    expect(h.pushes[0]?.assignmentEpoch).toBe(51)
  })

  it('refuses a seat that appears before the row lock is taken', async () => {
    const h = await harness(createRelayApp, { reserve: true })
    await h.placeRow()
    // Read 1 is the check before the transaction; read 2 is under the row lock.
    h.shadowState.onSeatsRead = (reads) => {
      if (reads === 2) { h.shadowState.seated.add(HOST) }
    }
    await expectRefused(h, await h.move(), 'host_seated')
    expect((await h.row())?.cell_id).toBe(RETIRING.id)
  })

  it('rolls the move back when a seat appears during the push', async () => {
    let seat: () => void = () => {}
    const h = await harness(createRelayApp, { reserve: true, onPush: () => seat() })
    seat = () => h.shadowState.seated.add(HOST)
    await h.placeRow(HOST, { invites: 3 })
    const response = await h.move()
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'dormant_edge_move_refused', reason: 'host_seated' })
    // Pushed, but the row (and its counters) never committed.
    expect(h.pushes).toHaveLength(1)
    expect(await h.row()).toMatchObject({ cell_id: RETIRING.id, reserved_invites: 3, assignment_epoch: 4 })
    expect(h.logged('orca_relay_edge_moved')).toEqual([])
  })
})

describe('the dormant move\'s retryable answers', () => {
  it('answers 503 when another transaction holds the host\'s lease rows', async () => {
    const h = await harness(createRelayApp, { leaseLockBusy: true })
    await h.placeRow()
    await expectBusy(h, await h.move(), 'relay_edge_move_busy')
  })

  it('answers 503 when the reserve-mode set cannot be read', async () => {
    const h = await harness(createRelayApp, { admitModesUnreadable: true })
    await h.placeRow()
    const response = await h.move()
    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('5')
    expect(await response.json()).toEqual({ error: 'database_temporarily_unavailable' })
    expect(h.logged('orca_relay_edge_dormant_move').at(-1)).toMatchObject({ outcome: 'busy', reason: 'reserve_mode_unknown' })
    expect(h.pushes).toHaveLength(0)
  })
})

describe('the dormant move leaves country exclusions to the host\'s next ask', () => {
  // As production: us-central1 excludes CN (and here unknown countries too); the rollout is 100%.
  const control = () => ({
    mode: 'on' as const,
    regionExcludeCountries: { 'us-central1': ['CN'] },
    regionExcludeUnknownCountry: { 'us-central1': true }
  })
  const ipCountry = parseIpCountryTable('192.0.2.0,192.0.2.127,CN\n192.0.2.128,192.0.2.255,HK\n')

  it('moves a rollout host in a region with country exclusions', async () => {
    const h = await harness(createRelayApp, { allowHosts: [], rolloutPercent: 100, control })
    await h.placeRow()
    expect((await h.move()).status).toBe(200)
    expect((await h.row())?.cell_id).toBe(EDGE_CELL_ID)
  })

  it('takes an excluded-country host off the edge at its next ask, as any excluded edge host', async () => {
    const h = await harness(createRelayApp, { allowHosts: [], rolloutPercent: 100, control, ipCountry })
    await h.placeRow()
    expect((await h.move()).status).toBe(200)
    expect((await h.row())?.cell_id).toBe(EDGE_CELL_ID)
    h.pushes.length = 0
    // The desktop comes back from China: the ask is judged with that country.
    const response = await h.ask(HOST, '192.0.2.1')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { cellUrl: string; assignmentEpoch: number }
    expect([RETIRING.url, OTHER.url]).toContain(body.cellUrl)
    // The edge's copy came back first, the row is on a cell above the edge epoch, and the edge
    // was told where the host went (its phones get WRONG_CELL, not HOST_OFFLINE).
    expect(h.exports).toEqual([HOST])
    const after = await h.row()
    expect(after?.cell_id).not.toBe(EDGE_CELL_ID)
    expect(Number(after?.assignment_epoch)).toBeGreaterThan(5)
    expect(h.pushes).toEqual([expect.objectContaining({ cellId: after?.cell_id, assignmentEpoch: body.assignmentEpoch })])
  })

  it('keeps an allowed-country host on the edge at its next ask', async () => {
    const h = await harness(createRelayApp, { allowHosts: [], rolloutPercent: 100, control, ipCountry })
    await h.placeRow()
    expect((await h.move()).status).toBe(200)
    const response = await h.ask(HOST, '192.0.2.200')
    expect(await response.json()).toMatchObject({ cellUrl: EDGE_URL, assignmentEpoch: 5 })
    expect(h.exports).toEqual([])
  })

  // Why the move checks inEdgeCohort only: every host it admits is within the leave ceiling, so
  // its next ask reads (and can leave) its edge row.
  it('only admits hosts mayBeOnEdge would read back', () => {
    const hosts = Array.from({ length: 400 }, (_, index) => `ceilinghost${String(index).padStart(5, '0')}`)
    const flagSets: EdgeControlFlags[] = [
      { mode: 'on', leaveCeilingPermille: 0, rolloutPermille: 300 },
      { mode: 'on', leaveCeilingPermille: 100, regionRolloutPermille: { 'us-central1': 700 } },
      { mode: 'on', leaveCeilingPermille: 0, regionRolloutPermille: { 'asia-east2': 900 } },
      { mode: 'on', leaveCeilingPermille: 50 }
    ]
    let admitted = 0
    for (const flags of flagSets) {
      const config: EdgeRelayConfig = {
        cellUrl: EDGE_URL,
        rolloutPercent: 20,
        allowHosts: new Set(),
        denyHosts: new Set(),
        regions: new Set(['us-central1']),
        control: () => flags
      }
      for (const relayHostId of hosts) {
        for (const region of ['us-central1', 'asia-east2'] as const) {
          if (inEdgeCohort(config, relayHostId, region, USER, null)) {
            admitted += 1
            expect(mayBeOnEdge(config, relayHostId, USER)).toBe(true)
          }
        }
      }
    }
    expect(admitted).toBeGreaterThan(0)
    expect(hosts.some((relayHostId) => edgeCohortBucketPermille(relayHostId) >= 900)).toBe(true)
  })
})
