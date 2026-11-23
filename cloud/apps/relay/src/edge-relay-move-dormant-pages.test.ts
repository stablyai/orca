import { afterEach, describe, expect, it, vi } from 'vitest'
import { harness, closeHarnesses } from './test-fixtures/edge-dormant-move-harness.js'
import { RETIRING, OTHER, USER } from './test-fixtures/edge-dormant-move-fixtures.js'
import { EDGE_CELL_ID } from './edge-relay.js'
import { DORMANT_PAGE_SCAN_MAX } from './assignment/assignment-store.js'
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

describe('POST /v1/admin/dormant-assignments', () => {
  it('pages a cell in key order with an opaque cursor', async () => {
    const h = await harness(createRelayApp)
    const hosts = ['dormantpage00001', 'dormantpage00002', 'dormantpage00003']
    for (const relayHostId of hosts) { await h.placeRow(relayHostId) }
    await h.placeRow('dormantpage00009', { cellId: OTHER.id })
    const first = (await (await h.list({ cellId: RETIRING.id, limit: 2 })).json()) as {
      candidates: { relayHostId: string }[]
      cursor: string
    }
    expect(first.candidates.map((candidate) => candidate.relayHostId)).toEqual(hosts.slice(0, 2))
    expect(first.cursor).toEqual(expect.any(String))
    const second = (await (await h.list({ cellId: RETIRING.id, limit: 2, cursor: first.cursor })).json()) as {
      candidates: { relayHostId: string }[]
      cursor: string | null
    }
    expect(second.candidates.map((candidate) => candidate.relayHostId)).toEqual(hosts.slice(2))
    expect(second.cursor).toBeNull()
  })

  it('bounds the page and refuses a cursor it did not make', async () => {
    const h = await harness(createRelayApp)
    expect((await h.list({ cellId: RETIRING.id, limit: 101 })).status).toBe(400)
    expect((await h.list({ cellId: RETIRING.id, cursor: 'not-a-cursor' })).status).toBe(400)
    expect((await h.list({ cellId: EDGE_CELL_ID })).status).toBe(400)
  })
})

describe('dormant-assignments reads a bounded window of keys per call', () => {
  it(`returns a cursor and no candidate when ${DORMANT_PAGE_SCAN_MAX} keys held none`, async () => {
    const h = await harness(createRelayApp)
    // Keys that sort before the one candidate, all on another cell.
    const others = Array.from({ length: DORMANT_PAGE_SCAN_MAX }, (_, index) => `aaother${String(index).padStart(9, '0')}`)
    for (let start = 0; start < others.length; start += 500) {
      const batch = others.slice(start, start + 500)
      await h.database.query(
        `INSERT INTO relay_assignments
         (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at, last_activity_at,
          reserved_controls, reserved_splices, reserved_invites, pending_installs,
          pending_confirmations, migration_leases)
         VALUES ${batch.map(() => `(?, ?, ?, 1, 0, 0, 0, 0, 0, 0, 0, 0)`).join(', ')}`,
        batch.flatMap((relayHostId) => [USER, relayHostId, OTHER.id])
      )
    }
    await h.placeRow('zzcandidate00001')
    const first = (await (await h.list({ cellId: RETIRING.id })).json()) as { candidates: unknown[]; cursor: string | null }
    expect(first.candidates).toEqual([])
    expect(first.cursor).toEqual(expect.any(String))
    const second = (await (await h.list({ cellId: RETIRING.id, cursor: first.cursor })).json()) as {
      candidates: { relayHostId: string }[]
      cursor: string | null
    }
    expect(second.candidates.map((candidate) => candidate.relayHostId)).toEqual(['zzcandidate00001'])
    expect(second.cursor).toBeNull()
  })
})
