import { describe, expect, it, vi } from 'vitest'
import type { RelayAssignment } from './assignment-store.js'
import type { RelayConfig } from './config.js'
import {
  classifyShadowSeat,
  SHADOW_COMPARE_FLUSH_MS,
  SHADOW_COMPARE_SAMPLES_PER_CLASS,
  SHADOW_COMPARE_SUPERSEDED_CLOSE_MS,
  ShadowDirectoryCompare
} from './shadow-directory-compare.js'
import { ShadowSeatDirectory, type SeatFeedResponse } from './shadow-seat-directory.js'

const fakes = vi.hoisted(() => ({
  verifyRelayToken: vi.fn(async (token: string) => ({ sub: 'user-a', relayHostId: token }))
}))

vi.mock('./relay-token-verifier.js', () => ({
  createRelayTokenVerifier: () => fakes.verifyRelayToken,
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

import { createRelayApp } from './app.js'

const HOST = 'hhhhhhhhhhhhhhhh'
const IDENTITY = { userId: 'user-a', relayHostId: HOST }

function feed(cellId: string, overrides: Partial<SeatFeedResponse> = {}): SeatFeedResponse {
  return { v: 1, cellId, incarnation: `inc-${cellId}`, seq: 1, at: 1, full: [], ...overrides }
}

function seat(epoch: number, state = 'active', relayHostId = HOST, joinedAt = 1) {
  return { userId: 'user-a', relayHostId, epoch, generation: 1, state, joinedAt }
}

function directoryWith(
  seats: Record<string, ReturnType<typeof seat>[]>,
  noFeed: string[] = [],
  unlive: string[] = []
) {
  const directory = new ShadowSeatDirectory()
  const cellIds = [...Object.keys(seats), ...noFeed]
  directory.setCells(cellIds, cellIds, {
    readAt: 0,
    expiresAt: new Map(
      cellIds.filter((cellId) => !unlive.includes(cellId)).map((cellId) => [cellId, 1e12])
    )
  })
  for (const [cellId, full] of Object.entries(seats)) {
    directory.apply(cellId, feed(cellId, { full }), 10)
  }
  for (const cellId of noFeed) directory.markNoFeed(cellId, 10)
  return directory
}

describe('classifyShadowSeat', () => {
  const at = (cellId: string, assignmentEpoch: number) => ({ cellId, assignmentEpoch })

  it('classifies each disagreement', () => {
    const cases: [ShadowSeatDirectory, ReturnType<typeof at> | null, string, boolean][] = [
      [directoryWith({ 'cell-a': [seat(3)] }), at('cell-a', 3), 'agree', true],
      [directoryWith({ 'cell-a': [] }), null, 'agree-absent', true],
      [directoryWith({ 'cell-a': [seat(3)] }), null, 'map-only', false],
      [directoryWith({ 'cell-a': [] }, ['cell-b']), at('cell-b', 3), 'cell-no-feed', true],
      [directoryWith({ 'cell-a': [] }), at('cell-z', 3), 'cell-unpolled', true],
      [directoryWith({ 'cell-a': [] }), at('cell-a', 3), 'db-only-unseen', true],
      [
        directoryWith({ 'cell-a': [], 'cell-b': [seat(2)] }),
        at('cell-a', 3),
        'cell-mismatch',
        true
      ],
      [
        directoryWith({ 'cell-a': [], 'cell-b': [seat(4)] }),
        at('cell-a', 3),
        'cell-mismatch',
        false
      ],
      [directoryWith({ 'cell-a': [seat(2)] }), at('cell-a', 3), 'epoch-mismatch', true],
      [directoryWith({ 'cell-a': [seat(4)] }), at('cell-a', 3), 'epoch-mismatch', false],
      [
        directoryWith({ 'cell-a': [seat(3)], 'cell-b': [seat(2, 'drain-only')] }),
        at('cell-a', 3),
        'duplicate-seat',
        true
      ],
      [
        directoryWith({ 'cell-a': [seat(3)], 'cell-b': [seat(3)] }),
        at('cell-a', 3),
        'duplicate-seat',
        false
      ]
    ]
    for (const [directory, answer, expectedClass, explained] of cases) {
      expect(classifyShadowSeat(directory, IDENTITY, answer, 20)).toEqual({
        class: expectedClass,
        explained
      })
    }
  })

  it('reads a null answer for a seat on a cell the database calls dead as its own class', () => {
    const directory = directoryWith({ 'cell-a': [seat(3)] }, [], ['cell-a'])
    expect(classifyShadowSeat(directory, IDENTITY, null, 20)).toEqual({
      class: 'map-only-cell-unlive',
      explained: true
    })
  })

  it('explains a long-seated host moved by a rehome, then stops once the move is old', () => {
    const directory = directoryWith({ 'cell-b': [seat(2)], 'cell-a': [] })
    const threeHours = 3 * 60 * 60 * 1_000
    const poll = (cellId: string, now: number) =>
      directory.apply(cellId, feed(cellId, { full: undefined, changes: [] }), now)
    poll('cell-b', threeHours)
    poll('cell-a', threeHours)
    const lines: Record<string, unknown>[] = []
    let now = threeHours
    const compare = new ShadowDirectoryCompare(
      directory,
      () => now,
      (line) => lines.push(JSON.parse(line))
    )
    expect(compare.compare('sticky-verify', IDENTITY, at('cell-a', 3))).toEqual({
      class: 'cell-mismatch',
      explained: true
    })
    now = threeHours + 10_001
    poll('cell-b', now)
    poll('cell-a', now)
    expect(compare.compare('resolve', IDENTITY, at('cell-a', 3))).toEqual({
      class: 'cell-mismatch',
      explained: false
    })
  })

  it('classifies without recording a sighting', () => {
    const directory = directoryWith({ 'cell-b': [seat(2)], 'cell-a': [] })
    classifyShadowSeat(directory, IDENTITY, at('cell-a', 3), 10)
    expect(directory.databaseEpochFirstSeen('user-a', HOST, 3)).toBeUndefined()
  })

  it('counts a seat on a cell not polled within the bound as cell-unpolled', () => {
    const directory = directoryWith({ 'cell-b': [seat(2)], 'cell-a': [] })
    expect(classifyShadowSeat(directory, IDENTITY, at('cell-a', 3), 10)).toMatchObject({
      explained: true
    })
    directory.apply('cell-a', feed('cell-a', { full: undefined, changes: [] }), 20_010)
    expect(classifyShadowSeat(directory, IDENTITY, at('cell-a', 3), 20_010)).toEqual({
      class: 'cell-unpolled',
      explained: true
    })
  })

  it('keeps a cell without a feed out of the coverage count, on either side of the compare', () => {
    const directory = directoryWith({ 'cell-b': [seat(2)], 'cell-a': [] })
    directory.markNoFeed('cell-b', 20)
    for (const answer of [at('cell-a', 3), at('cell-b', 2)]) {
      expect(classifyShadowSeat(directory, IDENTITY, answer, 30)).toEqual({
        class: 'cell-no-feed',
        explained: true
      })
    }
  })

  it('reads a null answer on a cell whose heartbeat ran out after the list read as pending', () => {
    const directory = directoryWith({ 'cell-a': [seat(3)] })
    const listRead = (readAt: number) =>
      directory.setCells(['cell-a'], ['cell-a'], { readAt, expiresAt: new Map([['cell-a', 150]]) })
    listRead(100)
    expect(classifyShadowSeat(directory, IDENTITY, null, 200)).toEqual({
      class: 'cell-unlive-pending',
      explained: true
    })
    listRead(160)
    expect(classifyShadowSeat(directory, IDENTITY, null, 200)).toEqual({
      class: 'map-only-cell-unlive',
      explained: true
    })
  })

  it('reads a host that left the named cell as db-only-left', () => {
    const directory = directoryWith({ 'cell-a': [seat(3)] })
    const leave = { seq: 2, kind: 'leave', ...IDENTITY, epoch: 3, generation: 1, at: 15 }
    directory.apply('cell-a', feed('cell-a', { seq: 2, full: undefined, changes: [leave] }), 15)
    expect(classifyShadowSeat(directory, IDENTITY, at('cell-a', 3), 20)).toEqual({
      class: 'db-only-left',
      explained: true
    })
  })

  describe('a duplicate seat left by a superseded half-open control', () => {
    // Seated on cell-b at epoch 2 long ago; the director first saw epoch 3 on cell-a at firstSeen.
    const firstSeen = 1_000_000
    const directoryAt = (seats: Record<string, ReturnType<typeof seat>[]>) => {
      const directory = directoryWith(seats)
      directory.observeDatabaseEpoch('user-a', HOST, 3, firstSeen)
      return directory
    }
    const superseded = (joinedAt = firstSeen) =>
      directoryAt({
        'cell-a': [seat(3, 'active', HOST, joinedAt)],
        'cell-b': [seat(2, 'active', HOST, 1)]
      })

    it('is explained while the old control may still await its silence close', () => {
      for (const now of [firstSeen + 1_700, firstSeen + SHADOW_COMPARE_SUPERSEDED_CLOSE_MS]) {
        expect(classifyShadowSeat(superseded(), IDENTITY, at('cell-a', 3), now)).toEqual({
          class: 'duplicate-seat',
          explained: true
        })
      }
    })

    it('is unexplained just past the close bound', () => {
      const now = firstSeen + SHADOW_COMPARE_SUPERSEDED_CLOSE_MS + 1
      expect(classifyShadowSeat(superseded(), IDENTITY, at('cell-a', 3), now)).toEqual({
        class: 'duplicate-seat',
        explained: false
      })
    })

    it('stays unexplained past the bound after a same-epoch rejoin resets joinedAt', () => {
      const now = firstSeen + SHADOW_COMPARE_SUPERSEDED_CLOSE_MS + 30_000
      expect(classifyShadowSeat(superseded(now - 1_000), IDENTITY, at('cell-a', 3), now)).toEqual({
        class: 'duplicate-seat',
        explained: false
      })
    })

    const unseen = () =>
      directoryWith({
        'cell-a': [seat(3, 'active', HOST, firstSeen)],
        'cell-b': [seat(2, 'active', HOST, 1)]
      })

    it('is its own unexplained class with no sighting in the instance\'s first 100 s', () => {
      const now = firstSeen + 1_700
      const startedAt = now - SHADOW_COMPARE_SUPERSEDED_CLOSE_MS
      expect(classifyShadowSeat(unseen(), IDENTITY, at('cell-a', 3), now, startedAt)).toEqual({
        class: 'superseded-unknown-age',
        explained: false
      })
    })

    it('is a plain unexplained duplicate with no sighting after the first 100 s', () => {
      const now = firstSeen + 1_700
      const startedAt = now - SHADOW_COMPARE_SUPERSEDED_CLOSE_MS - 1
      for (const classified of [
        classifyShadowSeat(unseen(), IDENTITY, at('cell-a', 3), now, startedAt),
        classifyShadowSeat(unseen(), IDENTITY, at('cell-a', 3), now)
      ]) {
        expect(classified).toEqual({ class: 'duplicate-seat', explained: false })
      }
    })

    it('stays a plain duplicate with no sighting when the current seat joined long ago', () => {
      const now = firstSeen + SHADOW_COMPARE_SUPERSEDED_CLOSE_MS + 1
      const directory = directoryWith({
        'cell-a': [seat(3, 'active', HOST, firstSeen)],
        'cell-b': [seat(2, 'active', HOST, 1)]
      })
      expect(classifyShadowSeat(directory, IDENTITY, at('cell-a', 3), now)).toEqual({
        class: 'duplicate-seat',
        explained: false
      })
    })

    it('classifies before recording, so a later epoch bump is explained', () => {
      const directory = directoryWith({
        'cell-a': [seat(2, 'active', HOST, firstSeen)],
        'cell-b': [seat(1, 'active', HOST, 1)]
      })
      let now = firstSeen
      const compare = new ShadowDirectoryCompare(directory, () => now, () => {})
      expect(compare.compare('sticky-verify', IDENTITY, at('cell-a', 2))).toEqual({
        class: 'superseded-unknown-age',
        explained: false
      })
      now = firstSeen + 1_700
      directory.apply(
        'cell-b',
        feed('cell-b', { seq: 2, full: [seat(3, 'active', HOST, now)] }),
        now
      )
      expect(compare.compare('sticky-verify', IDENTITY, at('cell-b', 3))).toEqual({
        class: 'duplicate-seat',
        explained: true
      })
    })

    it('is explained when the director last saw the host at a lower epoch', () => {
      const directory = directoryWith({
        'cell-a': [seat(3, 'active', HOST, firstSeen)],
        'cell-b': [seat(2, 'active', HOST, 1)]
      })
      directory.observeDatabaseEpoch('user-a', HOST, 2, 1)
      expect(classifyShadowSeat(directory, IDENTITY, at('cell-a', 3), firstSeen + 1_700)).toEqual({
        class: 'duplicate-seat',
        explained: true
      })
    })

    it('is unexplained after a lower-epoch sighting when the current seat joined long ago', () => {
      const now = firstSeen + SHADOW_COMPARE_SUPERSEDED_CLOSE_MS + 1
      const directory = directoryWith({
        'cell-a': [seat(3, 'active', HOST, firstSeen)],
        'cell-b': [seat(2, 'active', HOST, 1)]
      })
      directory.observeDatabaseEpoch('user-a', HOST, 2, 1)
      expect(classifyShadowSeat(directory, IDENTITY, at('cell-a', 3), now)).toEqual({
        class: 'duplicate-seat',
        explained: false
      })
    })

    it('is unexplained when the database answer regresses below the recorded epoch', () => {
      const directory = directoryWith({
        'cell-a': [seat(3, 'active', HOST, firstSeen)],
        'cell-b': [seat(2, 'active', HOST, 1)]
      })
      directory.observeDatabaseEpoch('user-a', HOST, 4, firstSeen)
      expect(classifyShadowSeat(directory, IDENTITY, at('cell-a', 3), firstSeen + 1_700)).toEqual({
        class: 'duplicate-seat',
        explained: false
      })
    })

    it('is unexplained when the database names a newer epoch than the seat on its cell', () => {
      const directory = directoryWith({
        'cell-a': [seat(3, 'active', HOST, firstSeen)],
        'cell-b': [seat(2, 'active', HOST, 1)]
      })
      directory.observeDatabaseEpoch('user-a', HOST, 4, firstSeen)
      expect(classifyShadowSeat(directory, IDENTITY, at('cell-a', 4), firstSeen + 1_700)).toEqual({
        class: 'duplicate-seat',
        explained: false
      })
    })

    it('is unexplained when the database names the lower epoch, or matches no seat', () => {
      for (const answer of [at('cell-b', 2), at('cell-a', 4), at('cell-b', 3)]) {
        expect(classifyShadowSeat(superseded(), IDENTITY, answer, firstSeen + 1_700)).toEqual({
          class: 'duplicate-seat',
          explained: false
        })
      }
    })

    it('is unexplained on a level epoch, which only the row can break', () => {
      const directory = directoryAt({
        'cell-a': [seat(3, 'active', HOST, firstSeen)],
        'cell-b': [seat(3, 'active', HOST, 1)]
      })
      expect(classifyShadowSeat(directory, IDENTITY, at('cell-a', 3), firstSeen + 1_700)).toEqual({
        class: 'duplicate-seat',
        explained: false
      })
    })
  })

  it('answers map-incomplete until every listed cell has answered', () => {
    const directory = new ShadowSeatDirectory()
    directory.setCells(['cell-a', 'cell-b'])
    directory.apply('cell-a', feed('cell-a', { full: [seat(3)] }), 10)
    expect(classifyShadowSeat(directory, IDENTITY, at('cell-a', 3), 20).class).toBe(
      'map-incomplete'
    )
  })
})

describe('ShadowDirectoryCompare', () => {
  it('flushes one count line per route and class, and rate-limits unexplained samples', () => {
    let now = 0
    const lines: Record<string, unknown>[] = []
    const compare = new ShadowDirectoryCompare(
      directoryWith({ 'cell-a': [seat(3)] }),
      () => now,
      (line) => lines.push(JSON.parse(line))
    )
    for (let index = 0; index < SHADOW_COMPARE_SAMPLES_PER_CLASS + 5; index += 1) {
      compare.compare('resolve', IDENTITY, null)
    }
    compare.compare('sticky-verify', IDENTITY, assignment('cell-a'))
    const samples = lines.filter((line) => line.event === 'orca_relay_shadow_compare_unexplained')
    expect(samples).toHaveLength(SHADOW_COMPARE_SAMPLES_PER_CLASS)
    now = SHADOW_COMPARE_FLUSH_MS
    compare.compare('sticky-verify', IDENTITY, assignment('cell-a'))
    expect(lines.filter((line) => line.event === 'orca_relay_shadow_compare')).toEqual([
      {
        event: 'orca_relay_shadow_compare',
        route: 'resolve',
        class: 'map-only',
        explained: false,
        count: SHADOW_COMPARE_SAMPLES_PER_CLASS + 5,
        windowMs: SHADOW_COMPARE_FLUSH_MS,
        countByCell: { 'cell-a': SHADOW_COMPARE_SAMPLES_PER_CLASS + 5 }
      },
      {
        event: 'orca_relay_shadow_compare',
        route: 'sticky-verify',
        class: 'agree',
        explained: true,
        count: 2,
        windowMs: SHADOW_COMPARE_FLUSH_MS,
        countByCell: { 'cell-a': 2 }
      }
    ])
  })

  it('counts a compare once on every cell it involves, and on none for a host neither side has', () => {
    const lines: Array<Record<string, unknown>> = []
    const compareOn = (seats: Record<string, ReturnType<typeof seat>[]>) =>
      new ShadowDirectoryCompare(directoryWith(seats), () => 0, (line) => lines.push(JSON.parse(line)))
    const unseen = compareOn({ 'cell-a': [], 'cell-b': [] })
    unseen.compare('sticky-verify', IDENTITY, assignment('cell-a'))
    unseen.compare('sticky-verify', IDENTITY, assignment('cell-a'))
    unseen.compare('sticky-verify', IDENTITY, assignment('cell-b'))
    unseen.compare('resolve', IDENTITY, null)
    unseen.flush(0)
    const mismatch = compareOn({ 'cell-a': [], 'cell-b': [seat(4)] })
    mismatch.compare('sticky-verify', IDENTITY, assignment('cell-a'))
    mismatch.flush(0)
    // A level-epoch duplicate counts on the database's own cell once, and on the other seat cell.
    const duplicate = compareOn({ 'cell-a': [seat(3)], 'cell-b': [seat(3)] })
    duplicate.compare('sticky-verify', IDENTITY, assignment('cell-a'))
    duplicate.flush(0)
    // A drain-only second seat is explained, so it counts only on the database's cell.
    const draining = compareOn({ 'cell-a': [seat(3)], 'cell-b': [seat(2, 'drain-only')] })
    draining.compare('sticky-verify', IDENTITY, assignment('cell-a'))
    draining.flush(0)
    // First sighting cannot date a superseded seat; subsequent compares explain it and count only the database cell.
    const superseded = compareOn({ 'cell-a': [seat(3)], 'cell-b': [seat(2)] })
    superseded.compare('sticky-verify', IDENTITY, assignment('cell-a'))
    superseded.compare('sticky-verify', IDENTITY, assignment('cell-a'))
    superseded.flush(0)
    const mapOnly = compareOn({ 'cell-a': [seat(3)], 'cell-b': [seat(3)] })
    mapOnly.compare('resolve', IDENTITY, null)
    mapOnly.flush(0)
    const counts = lines.filter((line) => line.event === 'orca_relay_shadow_compare')
    expect(counts.map((line) => [line.class, line.explained, line.count, line.countByCell])).toEqual([
      ['db-only-unseen', true, 3, { 'cell-a': 2, 'cell-b': 1 }],
      ['agree-absent', true, 1, {}],
      ['cell-mismatch', false, 1, { 'cell-a': 1, 'cell-b': 1 }],
      ['duplicate-seat', false, 1, { 'cell-a': 1, 'cell-b': 1 }],
      ['duplicate-seat', true, 1, { 'cell-a': 1 }],
      ['superseded-unknown-age', false, 1, { 'cell-a': 1, 'cell-b': 1 }],
      ['duplicate-seat', true, 1, { 'cell-a': 1 }],
      ['map-only', false, 1, { 'cell-a': 1, 'cell-b': 1 }]
    ])
  })
})

describe('unexplained samples', () => {
  it('log only the cell and epoch of the real database record, never raw ids', () => {
    const lines: Record<string, unknown>[] = []
    const compare = new ShadowDirectoryCompare(
      directoryWith({ 'cell-a': [seat(3)] }),
      () => 20,
      (line) => lines.push(JSON.parse(line))
    )
    compare.compare('sticky-verify', IDENTITY, { ...assignment('cell-a'), assignmentEpoch: 2 })
    compare.flush(20)
    const sample = lines.find((line) => line.event === 'orca_relay_shadow_compare_unexplained')
    expect(sample).toMatchObject({
      class: 'epoch-mismatch',
      db: { cellId: 'cell-a', assignmentEpoch: 2 }
    })
    expect(JSON.stringify(lines)).not.toContain(HOST)
    expect(JSON.stringify(lines)).not.toContain('user-a')
  })
})

describe('compare hooks on the director routes', () => {
  async function respond(compareShadowSeats?: () => void) {
    const resolved = assignment('cell-a')
    const app = createRelayApp(config(), {
      // SAFETY: /v1/resolve reads only resolveResume.
      store: { resolveResume: vi.fn(async () => ({ userId: 'user-a' })) } as never,
      // SAFETY: both routes read only resolve and assign.
      assignments: {
        resolve: vi.fn(async () => resolved),
        assign: vi.fn(async () => resolved)
      } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true),
      compareShadowSeats
    })
    const sticky = await app.request('/v1/assign', {
      method: 'POST',
      headers: { authorization: `Bearer ${HOST}`, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, relayHostId: HOST, reconnect: true })
    })
    const resolve = await app.request('/v1/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        relayHostId: HOST,
        resumeToken: Buffer.alloc(32, 1).toString('base64url')
      })
    })
    return [
      { status: sticky.status, body: await sticky.text() },
      { status: resolve.status, body: await resolve.text() }
    ]
  }

  it('compares after each database answer without changing a response byte', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    try {
      const baseline = await respond()
      const routes: unknown[] = []
      const compared = await respond((...args: unknown[]) => {
        routes.push(args[0])
      })
      const throwing = await respond(() => {
        throw new Error('compare broke')
      })

      expect(baseline[0]?.status).toBe(200)
      expect(baseline[1]?.status).toBe(200)
      expect(compared).toEqual(baseline)
      expect(throwing).toEqual(baseline)
      expect(routes).toEqual(['sticky-verify', 'resolve'])
    } finally {
      vi.useRealTimers()
    }
  })
})

function assignment(cellId: string): RelayAssignment {
  return {
    userId: 'user-a',
    relayHostId: HOST,
    cellId,
    cellUrl: `https://${cellId}.relay.example.test`,
    assignmentEpoch: 3,
    leaseExpiresAt: 1_300_000
  }
}

function config(): RelayConfig {
  return {
    port: 8080,
    publicUrl: 'https://relay.example.test',
    cellUrl: 'https://relay.example.test',
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
    publicAssignmentConcurrency: 2,
    publicAssignmentQueueMax: 128,
    publicAssignmentWaitMs: 4_000,
    publicResolveConcurrency: 1,
    publicResolveWaitMs: 5_000,
    publicAssignmentRetryAfterSeconds: 5,
    dataDir: './data'
  }
}
