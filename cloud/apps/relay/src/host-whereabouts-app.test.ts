import { describe, expect, it, vi } from 'vitest'
import type { HostWhereaboutsRow } from './assignment-store.js'
import { RelayAssignmentStore } from './assignment-store.js'
import type { RelayConfig } from './config.js'
import { openInMemoryRelayDatabase } from './database.js'
import { ShadowSeatDirectory } from './shadow-seat-directory.js'

vi.mock('./admin-token-verifier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./admin-token-verifier.js')>()
  const identities = new Map<string, Parameters<typeof actual.relayAdminIdentityMayAccess>[0]>([
    ['deploy-token', 'deploy'],
    ['monitor-token', 'monitor'],
    ['fence-token', 'fence'],
    ['capacity-token', 'capacity']
  ])
  return {
    ...actual,
    // The real route allow-list behind a token-to-identity stub.
    createAdminTokenVerifier: () => async (token: string, route?: string) => {
      const identity = identities.get(token)
      if (identity === undefined) return false
      return !route || actual.relayAdminIdentityMayAccess(identity, route)
    },
    createReadOnlyAdminTokenVerifier: () => async () => false,
    createRegionalRehomeControlApplyTokenVerifier: () => async () => false,
    createRegionalRehomeRuntimeTokenVerifier: () => async () => false,
    createRegionalRehomeTokenVerifier: () => async () => false,
    createRuntimeTokenVerifier: () => async () => false
  }
})

vi.mock('./relay-token-verifier.js', () => ({
  createRelayTokenVerifier: () => async () => null,
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

import { createRelayApp } from './app.js'

const HOST = 'hhhhhhhhhhhhhhhh'
const ROW: HostWhereaboutsRow = {
  cellId: 'cell-a',
  assignmentEpoch: 3,
  leaseExpiresAt: 5_000,
  openMigration: null
}

function request(body: unknown, token = 'deploy-token'): RequestInit {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }
}

function directory(): ShadowSeatDirectory {
  const shadow = new ShadowSeatDirectory()
  shadow.setCells(['cell-a', 'cell-b'])
  shadow.apply(
    'cell-a',
    {
      v: 1,
      cellId: 'cell-a',
      incarnation: 'inc-a',
      seq: 1,
      at: 1,
      flagsApplied: { generation: '7', flags: { readinessLocal: false } },
      full: [
        {
          userId: 'user-a',
          relayHostId: HOST,
          epoch: 3,
          generation: 1,
          state: 'active',
          joinedAt: 1
        }
      ]
    },
    Date.now()
  )
  shadow.markNoFeed('cell-b', Date.now())
  return shadow
}

function appWith(
  hostWhereabouts: (identity: { userId: string; relayHostId: string }) => Promise<unknown>,
  options: { shadowSeats?: ShadowSeatDirectory; role?: RelayConfig['role'] } = {}
) {
  return createRelayApp(config(options.role), {
    store: {} as never,
    // SAFETY: the whereabouts route reads only hostWhereabouts.
    assignments: { hostWhereabouts } as never,
    drain: vi.fn(),
    ready: vi.fn(async () => true),
    cellIncarnation: 'director-incarnation',
    shadowSeats: options.shadowSeats
  })
}

describe('POST /v1/admin/host-whereabouts', () => {
  it('requires admin auth and a director', async () => {
    const lookup = vi.fn(async () => ROW)
    const app = appWith(lookup)
    const body = { v: 1, relayHostId: HOST, userId: 'user-a' }

    expect((await app.request('/v1/admin/host-whereabouts', request(body, 'other'))).status).toBe(
      401
    )
    const cell = appWith(lookup, { role: 'cell' })
    expect((await cell.request('/v1/admin/host-whereabouts', request(body))).status).toBe(404)
    expect(
      (await app.request('/v1/admin/host-whereabouts', request({ ...body, extra: 1 }))).status
    ).toBe(400)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('lets the monitor and fence accounts read it, and not the capacity account', async () => {
    const app = appWith(async () => ROW)
    const body = { v: 1, relayHostId: HOST, userId: 'user-a' }
    for (const token of ['deploy-token', 'monitor-token', 'fence-token']) {
      const response = await app.request('/v1/admin/host-whereabouts', request(body, token))
      expect(response.status).toBe(200)
    }
    const capacity = await app.request(
      '/v1/admin/host-whereabouts',
      request(body, 'capacity-token')
    )
    expect(capacity.status).toBe(401)
  })

  it('returns the database row, the map seats, the verdict and the named cells', async () => {
    const lookup = vi.fn(async () => ROW)
    const app = appWith(lookup, { shadowSeats: directory() })

    const response = await app.request(
      '/v1/admin/host-whereabouts',
      request({ v: 1, relayHostId: HOST, userId: 'user-a' })
    )

    expect(response.status).toBe(200)
    expect(lookup).toHaveBeenCalledWith({ userId: 'user-a', relayHostId: HOST })
    expect(await response.json()).toMatchObject({
      v: 1,
      directorIncarnation: 'director-incarnation',
      relayHostId: HOST,
      shadow: { state: 'on', complete: true },
      users: [
        {
          userId: 'user-a',
          database: ROW,
          seats: [{ cellId: 'cell-a', epoch: 3, state: 'active' }],
          recentlyLeft: [],
          verdict: { class: 'agree', explained: true }
        }
      ],
      cells: {
        'cell-a': {
          status: 'live',
          lastFailure: null,
          flagsApplied: { generation: '7', flags: { readinessLocal: false } }
        }
      }
    })
  })

  it('names the user from the map when the request has only a host id', async () => {
    const lookup = vi.fn(async () => ROW)
    const app = appWith(lookup, { shadowSeats: directory() })

    const response = await app.request(
      '/v1/admin/host-whereabouts',
      request({ v: 1, relayHostId: HOST })
    )

    expect(lookup).toHaveBeenCalledWith({ userId: 'user-a', relayHostId: HOST })
    expect(await response.json()).toMatchObject({ users: [{ userId: 'user-a', database: ROW }] })
  })

  it('judges the verdict as /v1/resolve would when the row names a dead cell', async () => {
    const shadow = directory()
    // cell-a's heartbeat had already run out when the cell list was read.
    shadow.setCells(['cell-a', 'cell-b'], ['cell-a', 'cell-b'], {
      readAt: Date.now(),
      expiresAt: new Map([
        ['cell-a', Date.now() - 1],
        ['cell-b', Date.now() + 60_000]
      ])
    })
    const app = appWith(async () => ROW, { shadowSeats: shadow })

    const response = await app.request(
      '/v1/admin/host-whereabouts',
      request({ v: 1, relayHostId: HOST, userId: 'user-a' })
    )

    expect(await response.json()).toMatchObject({
      users: [{ database: ROW, verdict: { class: 'map-only-cell-unlive', explained: true } }]
    })
  })

  it('answers an unknown host with an empty result, not a 404', async () => {
    const lookup = vi.fn(async () => null)
    const shadowOff = appWith(lookup)
    const unknown = await shadowOff.request(
      '/v1/admin/host-whereabouts',
      request({ v: 1, relayHostId: 'uuuuuuuuuuuuuuuu' })
    )
    expect(unknown.status).toBe(200)
    expect(await unknown.json()).toEqual({
      v: 1,
      directorIncarnation: 'director-incarnation',
      relayHostId: 'uuuuuuuuuuuuuuuu',
      shadow: { state: 'off' },
      users: [],
      cells: {}
    })
    expect(lookup).not.toHaveBeenCalled()

    const named = await shadowOff.request(
      '/v1/admin/host-whereabouts',
      request({ v: 1, relayHostId: 'uuuuuuuuuuuuuuuu', userId: 'user-z' })
    )
    expect(await named.json()).toMatchObject({
      users: [{ userId: 'user-z', database: null, seats: [], recentlyLeft: [], verdict: null }]
    })
  })

  it('answers a briefly unreachable database with a retryable 503', async () => {
    const app = appWith(async () => {
      throw new Error('Connection terminated due to connection timeout')
    })
    const response = await app.request(
      '/v1/admin/host-whereabouts',
      request({ v: 1, relayHostId: HOST, userId: 'user-a' })
    )
    expect(response.status).toBe(503)
  })
})

describe('RelayAssignmentStore.hostWhereabouts', () => {
  it('reads the assignment row and its open migration by primary key', async () => {
    const database = await openInMemoryRelayDatabase()
    const store = new RelayAssignmentStore(database, () => 100)
    await store.reconcileCells([
      { id: 'cell-a', url: 'https://cell-a.example.test', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://cell-b.example.test', capacityRequests: 10 }
    ])
    const identity = { userId: 'user-a', relayHostId: HOST }
    expect(await store.hostWhereabouts(identity)).toBeNull()

    const assigned = await store.assign(identity)
    expect(await store.hostWhereabouts(identity)).toEqual({
      cellId: assigned.cellId,
      assignmentEpoch: assigned.assignmentEpoch,
      leaseExpiresAt: assigned.leaseExpiresAt,
      openMigration: null
    })

    await database.query(
      `INSERT INTO relay_assignment_migrations
       (user_id, relay_host_id, source_cell_id, target_cell_id, previous_epoch, assignment_epoch,
        source_request_units, target_reserved_units, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['user-a', HOST, 'cell-a', 'cell-b', 1, 2, 1, 1, 900, 100, 100]
    )
    expect((await store.hostWhereabouts(identity))?.openMigration).toEqual({
      sourceCellId: 'cell-a',
      targetCellId: 'cell-b',
      previousEpoch: 1,
      assignmentEpoch: 2,
      expiresAt: 900,
      targetRegisteredAt: null
    })
  })
})

function config(role: RelayConfig['role'] = 'director'): RelayConfig {
  return {
    port: 8080,
    publicUrl: 'https://relay.example.test',
    cellUrl: 'https://relay.example.test',
    authIssuer: 'https://auth.example.test',
    authAudience: 'orca-relay',
    jwksUrl: 'https://auth.example.test/jwks',
    assignmentSigningKey: new TextEncoder().encode('assignment-key-with-at-least-32-bytes'),
    role,
    cellId: role === 'cell' ? 'cell-a' : 'director',
    cells: [],
    adminAudience: 'https://relay.example.test/v1/admin/drain',
    deployServiceAccount: 'deploy@example.test',
    runtimeServiceAccount: 'runtime@example.test',
    adminJwksUrl: 'https://auth.example.test/jwks',
    databasePoolMax: 3,
    publicAssignmentsEnabled: true,
    publicAssignmentConcurrency: 2,
    publicAssignmentQueueMax: 128,
    publicAssignmentWaitMs: 4_000,
    publicResolveConcurrency: 1,
    publicResolveWaitMs: 5_000,
    publicAssignmentRetryAfterSeconds: 5,
    dataDir: './data'
  }
}
