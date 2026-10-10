import { describe, expect, it, vi } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import { openInMemoryRelayDatabase } from './database.js'
import {
  SHADOW_SEAT_RECENTLY_LEFT_MAX_HOSTS,
  ShadowSeatDirectory,
  startShadowSeatPoller,
  type SeatFeedCell,
  type SeatFeedResponse
} from './shadow-seat-directory.js'

const INCARNATION = '11111111-1111-4111-8111-111111111111'
const CELLS: SeatFeedCell[] = [
  {
    cellId: 'cell-a',
    cellUrl: 'https://cell-a.example.test',
    region: 'us-central1',
    heartbeatExpiresAt: 2_000_000_000_000,
    requiredForComplete: true
  },
  {
    cellId: 'cell-b',
    cellUrl: 'https://cell-b.example.test',
    region: 'asia-east2',
    heartbeatExpiresAt: 2_000_000_000_000,
    requiredForComplete: true
  }
]

function feed(overrides: Partial<SeatFeedResponse> = {}): SeatFeedResponse {
  return { v: 1, cellId: 'cell-a', incarnation: INCARNATION, seq: 0, at: 1, ...overrides }
}

function seat(relayHostId: string, generation = 1) {
  return { userId: 'user-a', relayHostId, epoch: 3, generation, state: 'active', joinedAt: 1 }
}

function change(
  seq: number,
  kind: string,
  relayHostId: string,
  generation = 1,
  closeCode?: number
) {
  return { seq, kind, userId: 'user-a', relayHostId, epoch: 3, generation, closeCode, at: 50 + seq }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

type Responder = (url: URL) => Response | Promise<Response>

function poller(
  responders: Record<string, Responder>,
  cells: 'all' | string[] = 'all',
  listCells: () => Promise<SeatFeedCell[]> = async () => CELLS
) {
  let now = 1_000
  const requests: URL[] = []
  const identityToken = vi.fn(async () => 'token-1')
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input))
    requests.push(url)
    const responder = responders[url.hostname.split('.')[0] ?? '']
    if (!responder) throw new Error('unreachable')
    return await responder(url)
  })
  const started = startShadowSeatPoller(
    {
      role: 'director',
      rehomeAudience: 'https://relay.example.test/rehome',
      shadowSeatFeedCells: cells
    },
    {
      listCells,
      fetch: fetchImpl,
      identityToken,
      now: () => now,
      pollMs: 3_600_000,
      log: () => undefined
    }
  )
  if (!started) throw new Error('poller not started')
  return {
    ...started,
    requests,
    identityToken,
    advance: (ms: number) => {
      now += ms
    }
  }
}

describe('startShadowSeatPoller', () => {
  it('polls nothing unless a director has cells switched on and the rehome audience', () => {
    const base = { role: 'director' as const, rehomeAudience: 'https://relay.example.test/rehome' }
    const options = { listCells: async () => CELLS }
    expect(startShadowSeatPoller(base, options)).toBeNull()
    expect(startShadowSeatPoller({ ...base, shadowSeatFeedCells: [] }, options)).toBeNull()
    expect(
      startShadowSeatPoller({ ...base, role: 'cell', shadowSeatFeedCells: 'all' }, options)
    ).toBeNull()
    expect(
      startShadowSeatPoller({ role: 'director', shadowSeatFeedCells: 'all' }, options)
    ).toBeNull()
  })

  it('takes a full snapshot first, then applies deltas from its cursor', async () => {
    let call = 0
    const cell = poller(
      {
        'cell-a': () => {
          call += 1
          if (call === 1) return json(feed({ seq: 2, full: [seat('host-1'), seat('host-2')] }))
          return json(
            feed({
              seq: 5,
              changes: [
                change(3, 'leave', 'host-1', 1, 4001),
                change(4, 'join', 'host-3'),
                change(5, 'drain-only', 'host-2')
              ]
            })
          )
        }
      },
      ['cell-a']
    )
    await cell.tick()
    expect(cell.requests[0]?.searchParams.has('since')).toBe(false)
    expect(cell.directory.seatsOf('user-a', 'host-1')).toHaveLength(1)

    await cell.tick()
    cell.stop()
    expect(cell.requests[1]?.searchParams.get('since')).toBe(`${INCARNATION}:2`)
    expect(cell.directory.seatsOf('user-a', 'host-1')).toEqual([])
    expect(cell.directory.recentlyLeftOf('user-a', 'host-1', 1_000)).toEqual([
      { cellId: 'cell-a', epoch: 3, generation: 1, incarnation: INCARNATION, closeCode: 4001, at: 53 }
    ])
    expect(cell.directory.seatsOf('user-a', 'host-2')).toMatchObject([{ state: 'drain-only' }])
    expect(cell.directory.seatsOf('user-a', 'host-3')).toMatchObject([
      { cellId: 'cell-a', epoch: 3, generation: 1, state: 'active' }
    ])
    expect(cell.directory.cellState('cell-a')).toMatchObject({ status: 'live', seq: 5 })
    expect(cell.identityToken).toHaveBeenCalledTimes(1)
  })

  it('resyncs from a full snapshot when the cell restarts with a new incarnation', async () => {
    let call = 0
    const cell = poller(
      {
        'cell-a': () => {
          call += 1
          if (call === 1) return json(feed({ seq: 2, full: [seat('host-1'), seat('host-2')] }))
          return json(
            feed({ incarnation: 'restarted', seq: 1, full: [seat('host-2', 1)] })
          )
        }
      },
      ['cell-a']
    )
    await cell.tick()
    await cell.tick()
    cell.stop()
    expect(cell.directory.seatsOf('user-a', 'host-1')).toEqual([])
    expect(cell.directory.recentlyLeftOf('user-a', 'host-1', 1_000)).toMatchObject([
      { cellId: 'cell-a', resync: true }
    ])
    expect(cell.directory.since('cell-a')).toBe('restarted:1')
  })

  it('asks for a full snapshot after a gap in the change sequence', async () => {
    let call = 0
    const cell = poller(
      {
        'cell-a': () => {
          call += 1
          if (call === 1) return json(feed({ seq: 2, full: [seat('host-1')] }))
          return json(feed({ seq: 9, changes: [change(9, 'join', 'host-9')] }))
        }
      },
      ['cell-a']
    )
    await cell.tick()
    await cell.tick()
    await cell.tick()
    cell.stop()
    expect(cell.directory.seatsOf('user-a', 'host-9')).toEqual([])
    expect(cell.directory.seatsOf('user-a', 'host-1')).toHaveLength(1)
    expect(cell.requests[2]?.searchParams.has('since')).toBe(false)
  })

  it('resumes a short page from its last change; an empty page behind the head resyncs', () => {
    const directory = new ShadowSeatDirectory()
    directory.setCells(['cell-a'])
    directory.apply('cell-a', feed({ seq: 2, full: [] }), 10)
    directory.apply(
      'cell-a',
      feed({ seq: 10, changes: [change(3, 'join', 'host-3'), change(4, 'join', 'host-4')] }),
      11
    )
    expect(directory.since('cell-a')).toBe(`${INCARNATION}:4`)
    directory.apply('cell-a', feed({ seq: 10, changes: [] }), 12)
    expect(directory.since('cell-a')).toBeUndefined()
    expect(directory.cellState('cell-a')).toMatchObject({ lastFailure: 'cursor_gap' })
  })

  it('checks the map against the cell seat count, with controls only as a cross-check', () => {
    const directory = new ShadowSeatDirectory()
    directory.setCells(['cell-a', 'cell-b'])
    directory.apply(
      'cell-a',
      feed({ seq: 1, counts: { seats: 2, controls: 1 }, full: [seat('host-1'), seat('host-2')] }),
      10
    )
    directory.apply(
      'cell-b',
      feed({ cellId: 'cell-b', seq: 1, counts: { seats: 3, controls: 3 }, full: [seat('host-3')] }),
      10
    )
    expect(directory.summary(10)).toMatchObject({
      seatsMismatchedCells: 1,
      controlsBelowMapCells: 1
    })
  })

  it('returns a drain-only seat to active, and ignores active for an older generation', () => {
    const directory = new ShadowSeatDirectory()
    directory.setCells(['cell-a'])
    directory.apply('cell-a', feed({ seq: 1, full: [seat('host-1', 2)] }), 10)
    directory.apply(
      'cell-a',
      feed({
        seq: 4,
        changes: [
          change(2, 'drain-only', 'host-1', 2),
          change(3, 'active', 'host-1', 2),
          change(4, 'active', 'host-9', 1)
        ]
      }),
      11
    )
    expect(directory.seatsOf('user-a', 'host-1')).toMatchObject([{ state: 'active' }])
    expect(directory.seatsOf('user-a', 'host-9')).toEqual([])
    directory.apply(
      'cell-a',
      feed({
        seq: 6,
        changes: [change(5, 'drain-only', 'host-1', 2), change(6, 'active', 'host-1', 1)]
      }),
      12
    )
    expect(directory.seatsOf('user-a', 'host-1')).toMatchObject([{ state: 'drain-only' }])
  })

  it('ignores a leave for an older generation than the seat', () => {
    const directory = new ShadowSeatDirectory()
    directory.setCells(['cell-a'])
    directory.apply('cell-a', feed({ seq: 1, full: [seat('host-1', 2)] }), 10)
    directory.apply('cell-a', feed({ seq: 2, changes: [change(2, 'leave', 'host-1', 1)] }), 11)
    expect(directory.seatsOf('user-a', 'host-1')).toMatchObject([{ generation: 2 }])
  })

  it('applies a change only at or above the seat generation', () => {
    const directory = new ShadowSeatDirectory()
    directory.setCells(['cell-a'])
    directory.apply('cell-a', feed({ seq: 1, full: [seat('host-1', 2)] }), 10)
    directory.apply(
      'cell-a',
      feed({
        seq: 3,
        changes: [change(2, 'join', 'host-1', 1), change(3, 'drain-only', 'host-1', 1)]
      }),
      11
    )
    expect(directory.seatsOf('user-a', 'host-1')).toMatchObject([
      { generation: 2, state: 'active' }
    ])
    directory.apply(
      'cell-a',
      feed({
        seq: 5,
        changes: [change(4, 'drain-only', 'host-9'), change(5, 'leave', 'host-1', 3)]
      }),
      12
    )
    expect(directory.seatsOf('user-a', 'host-1')).toEqual([])
    expect(directory.seatsOf('user-a', 'host-9')).toEqual([])
  })

  it('follows a cut page at once within the same poll', async () => {
    let call = 0
    const cell = poller(
      {
        'cell-a': () => {
          call += 1
          if (call === 1) return json(feed({ seq: 0, full: [] }))
          if (call === 2) {
            return json(feed({ seq: 1, more: true, changes: [change(1, 'join', 'host-1')] }))
          }
          return json(feed({ seq: 2, changes: [change(2, 'join', 'host-2')] }))
        }
      },
      ['cell-a']
    )
    await cell.tick()
    await cell.tick()
    cell.stop()
    expect(call).toBe(3)
    expect(cell.requests[2]?.searchParams.get('since')).toBe(`${INCARNATION}:1`)
    expect(cell.directory.seatsOf('user-a', 'host-2')).toHaveLength(1)
  })

  it('keeps seats as unverifiable through timeouts and errors, never as gone', async () => {
    let call = 0
    const cell = poller(
      {
        'cell-a': () => {
          call += 1
          if (call === 1) return json(feed({ seq: 1, full: [seat('host-1')] }))
          if (call === 2) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
          return json({ error: 'unavailable' }, 503)
        }
      },
      ['cell-a']
    )
    await cell.tick()
    await cell.tick()
    expect(cell.directory.cellState('cell-a')).toMatchObject({
      status: 'unverifiable',
      lastFailure: 'timeout'
    })
    await cell.tick()
    cell.stop()
    expect(cell.directory.cellState('cell-a')).toMatchObject({
      status: 'unverifiable',
      lastFailure: 'status_503'
    })
    expect(cell.directory.seatsOf('user-a', 'host-1')).toHaveLength(1)
    expect(cell.directory.since('cell-a')).toBe(`${INCARNATION}:1`)
  })

  it('reads an old cell (404) as no feed, and completes once every cell has answered', async () => {
    let cellBUp = false
    const cell = poller({
      'cell-a': () => json(feed({ seq: 1, full: [] })),
      'cell-b': () => {
        if (!cellBUp) throw new Error('connect refused')
        return new Response('Not Found', { status: 404 })
      }
    })
    await cell.tick()
    expect(cell.directory.isComplete()).toBe(false)
    cellBUp = true
    await cell.tick()
    cell.stop()
    expect(cell.directory.cellState('cell-b')).toMatchObject({ status: 'no-feed' })
    expect(cell.directory.isComplete()).toBe(true)
  })

  it('completes without a cell that is dead, empty or isolated', async () => {
    const cell = poller({ 'cell-a': () => json(feed({ seq: 1, full: [] })) }, 'all', async () => [
      CELLS[0]!,
      { ...CELLS[1]!, requiredForComplete: false }
    ])
    await cell.tick()
    cell.stop()
    expect(cell.directory.cellState('cell-b')).toMatchObject({ status: 'pending' })
    expect(cell.directory.isComplete()).toBe(true)
  })

  it('backs off cell-list reads while the database fails', async () => {
    const listCells = vi.fn(async (): Promise<SeatFeedCell[]> => {
      throw new Error('pool timeout')
    })
    const cell = poller({}, 'all', listCells)
    for (let second = 0; second < 40; second += 1) {
      await cell.tick()
      cell.advance(1_000)
    }
    cell.stop()
    // Retries at +1, +2, +4, +8, +16 s, then at most every 30 s.
    expect(listCells.mock.calls.length).toBeLessThanOrEqual(7)
    expect(listCells.mock.calls.length).toBeGreaterThanOrEqual(5)
  })

  it('treats a malformed or mislabelled body as unverifiable', async () => {
    const cell = poller({
      'cell-a': () => json({ v: 2 }),
      'cell-b': () => json(feed({ cellId: 'cell-a', full: [] }))
    })
    await cell.tick()
    cell.stop()
    expect(cell.directory.cellState('cell-a')).toMatchObject({ lastFailure: 'malformed' })
    expect(cell.directory.cellState('cell-b')).toMatchObject({ lastFailure: 'cell_id_mismatch' })
    expect(cell.directory.isComplete()).toBe(false)
  })

  it('accepts unknown fields and change kinds from a newer cell', () => {
    const directory = new ShadowSeatDirectory()
    directory.setCells(['cell-a'])
    directory.apply('cell-a', feed({ seq: 1, full: [seat('host-1')] }), 10)
    directory.apply('cell-a', feed({ seq: 2, changes: [change(2, 'future-kind', 'host-1')] }), 11)
    expect(directory.since('cell-a')).toBe(`${INCARNATION}:2`)
    expect(directory.seatsOf('user-a', 'host-1')).toHaveLength(1)
  })

  it('polls only the listed cells and drops a cell that leaves the list', async () => {
    const cell = poller(
      { 'cell-a': () => json(feed({ seq: 1, full: [seat('host-1')] })) },
      ['cell-a', 'cell-z']
    )
    await cell.tick()
    cell.stop()
    expect(cell.requests.map((url) => url.hostname)).toEqual(['cell-a.example.test'])
    cell.directory.setCells([])
    expect(cell.directory.seatsOf('user-a', 'host-1')).toEqual([])
  })

  it('bounds the recently-left memory', () => {
    const directory = new ShadowSeatDirectory()
    directory.setCells(['cell-a'])
    const hosts = SHADOW_SEAT_RECENTLY_LEFT_MAX_HOSTS + 10
    directory.apply(
      'cell-a',
      feed({ seq: 1, full: Array.from({ length: hosts }, (_, index) => seat(`host-${index}`)) }),
      10
    )
    directory.apply('cell-a', feed({ incarnation: 'restarted', seq: 1, full: [] }), 20)
    expect(directory.summary(20).recentlyLeftHosts).toBe(SHADOW_SEAT_RECENTLY_LEFT_MAX_HOSTS)
    expect(directory.recentlyLeftOf('user-a', 'host-0', 20)).toEqual([])
    expect(directory.recentlyLeftOf('user-a', `host-${hosts - 1}`, 20)).toHaveLength(1)
  })
})

describe('RelayAssignmentStore.seatFeedCells', () => {
  it('lists every cell, and requires only live, unisolated cells with capacity', async () => {
    const database = await openInMemoryRelayDatabase()
    const store = new RelayAssignmentStore(database, () => 100_000, {
      requireLiveCells: true,
      heartbeatTtlMs: 45_000
    })
    await store.reconcileCells(
      ['cell-live', 'cell-stale', 'cell-isolated', 'cell-empty', 'cell-nobeat', 'cell-off'].map(
        (id) => ({
          id,
          url: `https://${id}.example.test`,
          capacityRequests: id === 'cell-empty' ? 0 : 10
        })
      )
    )
    // Existing-only: no new hosts, but it still seats the ones it has.
    await database.query(`UPDATE relay_cells SET enabled = 0 WHERE cell_id = ?`, ['cell-off'])
    for (const [cellId, heartbeatAt] of [
      ['cell-live', 90_000],
      ['cell-stale', 10_000],
      ['cell-isolated', 90_000],
      ['cell-empty', 90_000],
      ['cell-off', 90_000]
    ] as const) {
      await database.query(
        `INSERT INTO relay_cell_runtime
         (cell_id, cell_url, cell_incarnation, started_at, ready, observed_requests,
          last_heartbeat_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [cellId, `https://${cellId}.example.test`, 'inc', 1, 1, 0, heartbeatAt, heartbeatAt]
      )
    }
    await database.query(
      `UPDATE relay_cell_admission SET roll_isolated_at = ? WHERE cell_id = ?`,
      [50_000, 'cell-isolated']
    )

    const cells = await store.seatFeedCells()

    expect(
      cells.map((cell) => [cell.cellId, cell.heartbeatExpiresAt, cell.requiredForComplete])
    ).toEqual([
      ['cell-empty', 135_000, false],
      ['cell-isolated', 135_000, false],
      ['cell-live', 135_000, true],
      ['cell-nobeat', null, false],
      ['cell-off', 135_000, true],
      ['cell-stale', 55_000, false]
    ])
  })
})
