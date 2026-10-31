import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PostgresDatabase } from './database.js'
import type pg from 'pg'
import {
  noteConnectionStatement,
  SLOW_CONNECTION_PEER_SLACK_MS,
  SLOW_CONNECTION_RETIRE_INTERVAL_MS,
  SLOW_CONNECTION_SAMPLE_MAX_AGE_MS,
  SLOW_CONNECTION_WINDOW,
  SlowConnectionRetirement
} from './postgres-connection-latency.js'
import { DIRECTOR_SLOW_CONNECTION_STALLS } from './test-fixtures/director-slow-connection-stalls.js'
import { DIRECTOR_TAIL_CONNECTION_STALLS } from './test-fixtures/director-tail-connection-stalls.js'

let clock = 0

type Slot = { name: string; statementMs: () => number }

// Hands out its connections in turn; a client released with a truthy value is replaced by a fresh
// 3 ms one, as pg-pool would dial a new connection on the next ask.
function pool(slots: Slot[], options: { retiresSlowConnections?: boolean } = { retiresSlowConnections: true }) {
  const destroyed: string[] = []
  let dialed = 0
  let turn = 0
  const dial = (slot: Slot) => {
    dialed++
    const client = Object.assign(new EventEmitter(), {
      query: async () => {
        clock += slot.statementMs()
        return { rows: [], rowCount: 0 }
      },
      release: (destroy?: unknown) => {
        if (destroy) {
          destroyed.push(slot.name)
          const index = live.indexOf(client)
          slot = { name: `${slot.name}-redial`, statementMs: () => 3 }
          live[index] = dial(slot)
        }
      }
    })
    return client
  }
  const live = slots.map(dial)
  const fake = {
    totalCount: slots.length,
    idleCount: 0,
    waitingCount: 0,
    connect: async () => live[turn++ % live.length]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: PostgresDatabase and its pool pressure read only connect, these counts and the optional options.
  const database = new PostgresDatabase(fake as never, undefined, options)
  return { database, destroyed, dialed: () => dialed }
}

const steady = (ms: number) => () => ms

async function runStatements(database: PostgresDatabase, count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await database.query('SELECT 1')
  }
}

describe('slow connection retirement', () => {
  let warnings: string[]

  beforeEach(() => {
    clock = 0
    warnings = []
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    vi.spyOn(console, 'warn').mockImplementation((line: string) => void warnings.push(line))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('retires one 55 ms connection among 3 ms peers, and logs it once', async () => {
    const slow = pool([
      { name: 'a', statementMs: steady(3) },
      { name: 'b', statementMs: steady(3) },
      { name: 'slow', statementMs: steady(55) }
    ])
    await runStatements(slow.database, SLOW_CONNECTION_WINDOW * 3)

    expect(slow.destroyed).toEqual(['slow'])
    expect(warnings.map((line) => JSON.parse(line))).toEqual([
      {
        event: 'orca_relay_postgres_slow_connection_retired',
        connectionId: 3,
        shape: 'median',
        medianMs: 55,
        peerMedianMs: 3,
        tailMs: 55,
        peerTailMs: 0,
        statements: SLOW_CONNECTION_WINDOW
      }
    ])
  })

  it('retires nothing in a pool whose round-trip floor is high, as in a far region', async () => {
    const far = pool(['a', 'b', 'c'].map((name) => ({ name, statementMs: steady(180) })))
    await runStatements(far.database, SLOW_CONNECTION_WINDOW * 6)

    expect(far.destroyed).toEqual([])
  })

  it('retires nothing when the whole database slows down', async () => {
    let slowDatabase = false
    const statementMs = () => (slowDatabase ? 60 : 3)
    const all = pool(['a', 'b', 'c'].map((name) => ({ name, statementMs })))
    await runStatements(all.database, SLOW_CONNECTION_WINDOW * 3)
    slowDatabase = true
    await runStatements(all.database, SLOW_CONNECTION_WINDOW * 6)

    expect(all.destroyed).toEqual([])
  })

  it('never retires the only connection, which has no peer to compare with', async () => {
    const single = pool([{ name: 'only', statementMs: steady(55) }])
    await runStatements(single.database, SLOW_CONNECTION_WINDOW * 4)

    expect(single.destroyed).toEqual([])
    expect(single.dialed()).toBe(1)
  })

  it('judges the median, so one long statement does not retire a healthy connection', async () => {
    let calls = 0
    const outlier = pool([
      { name: 'a', statementMs: steady(3) },
      { name: 'b', statementMs: () => (++calls === 4 ? 500 : 3) }
    ])
    await runStatements(outlier.database, SLOW_CONNECTION_WINDOW * 4)

    expect(outlier.destroyed).toEqual([])
  })

  it('forgets samples older than a minute, so a recovered connection is kept', async () => {
    let recovered = false
    const once = pool([
      { name: 'a', statementMs: steady(3) },
      { name: 'was-slow', statementMs: () => (recovered ? 3 : 55) }
    ])
    // One statement short of a full window each, so nothing is judged while it is slow.
    await runStatements(once.database, (SLOW_CONNECTION_WINDOW - 1) * 2)
    recovered = true
    clock += SLOW_CONNECTION_SAMPLE_MAX_AGE_MS + 1
    await runStatements(once.database, SLOW_CONNECTION_WINDOW * 4)

    expect(once.destroyed).toEqual([])
  })

  it('judges a transaction connection on release, never mid-transaction', async () => {
    const tx = pool([
      { name: 'a', statementMs: steady(3) },
      { name: 'slow', statementMs: steady(55) }
    ])
    // Each runs two short of a full window; one more turn leaves the next checkout on the slow one.
    await runStatements(tx.database, (SLOW_CONNECTION_WINDOW - 2) * 2 + 1)
    await tx.database.transaction(async (transaction) => {
      // BEGIN and this statement fill the window mid-transaction; nothing is judged until release.
      await transaction.query('SELECT 1')
      expect(tx.destroyed).toEqual([])
    })

    expect(tx.destroyed).toEqual(['slow'])
  })

  it('opens no connection itself, so the pool never grows', async () => {
    const slow = pool([
      { name: 'a', statementMs: steady(3) },
      { name: 'slow', statementMs: steady(55) }
    ])
    await runStatements(slow.database, SLOW_CONNECTION_WINDOW * 2)

    expect(slow.destroyed).toEqual(['slow'])
    // Two original connections plus the one redial that replaced the retired client.
    expect(slow.dialed()).toBe(3)
  })

  it('retires at most one connection per pool per interval', async () => {
    const two = pool([
      { name: 'a', statementMs: steady(3) },
      { name: 'b', statementMs: steady(3) },
      { name: 'slow-1', statementMs: steady(55) },
      { name: 'slow-2', statementMs: steady(55) }
    ])
    await runStatements(two.database, SLOW_CONNECTION_WINDOW * 4)
    expect(two.destroyed).toEqual(['slow-1'])

    clock += SLOW_CONNECTION_RETIRE_INTERVAL_MS
    await runStatements(two.database, 4)
    expect(two.destroyed).toEqual(['slow-1', 'slow-2'])
  })

  it('bounds the misfire at a database-wide slowdown onset while peers sit idle', () => {
    const retirement = new SlowConnectionRetirement(() => clock)
    const peers = [fakeClient(), fakeClient()]
    for (const peer of peers) {
      for (let index = 0; index < 8; index++) {
        retirement.track(peer)
        noteConnectionStatement(peer, 3)
        retirement.shouldRetire(peer, 1)
      }
    }
    // From here every statement is slow, and only the busy connection (and its redials) runs.
    let busy = fakeClient()
    let id = 10
    const retiredAt: number[] = []
    for (let elapsed = 0; elapsed < 120_000; elapsed += 60) {
      clock += 60
      retirement.track(busy)
      noteConnectionStatement(busy, 60)
      if (retirement.shouldRetire(busy, id)) {
        retiredAt.push(elapsed)
        busy = fakeClient()
        id++
      }
    }

    expect(retiredAt.length).toBeLessThanOrEqual(3)
    expect(retiredAt.length).toBeGreaterThan(0)
    expect(Math.max(...retiredAt)).toBeLessThan(SLOW_CONNECTION_PEER_SLACK_MS + SLOW_CONNECTION_RETIRE_INTERVAL_MS)
  })

  // Every 50th statement takes `outlierMs`: a 2% tail, like the ~200/400/800 ms retransmit stalls.
  const withTail = (baseMs: number, outlierMs: number) => {
    let calls = 0
    return () => (++calls % 50 === 0 ? outlierMs : baseMs)
  }

  it('retires one connection whose tail turned slow while its median stayed normal', async () => {
    const lossy = pool([
      { name: 'a', statementMs: steady(3) },
      { name: 'b', statementMs: steady(3) },
      { name: 'lossy', statementMs: withTail(3, 415) }
    ])
    await runStatements(lossy.database, 600)

    expect(lossy.destroyed).toEqual(['lossy'])
    expect(JSON.parse(warnings[0] ?? '{}')).toMatchObject({ shape: 'tail', tailMs: 415, peerTailMs: 3 })
  })

  it('retires nothing when every connection has the same tail, as a whole-database spike does', async () => {
    const spiky = pool(['a', 'b', 'c'].map((name) => ({ name, statementMs: withTail(3, 400) })))
    await runStatements(spiky.database, 900)

    expect(spiky.destroyed).toEqual([])
  })

  it('retires nothing on a far region whose healthy tail sits above 200 ms', async () => {
    const far = pool(['a', 'b', 'c'].map((name) => ({ name, statementMs: withTail(180, 260) })))
    await runStatements(far.database, 900)

    expect(far.destroyed).toEqual([])
  })

  it.each([
    ['14:58', 320, '14:58:22'],
    ['15:24', 367, '15:24:22']
  ] as const)('replays the %s tail stall of 2026-10-26 and retires c%i in the window ending %s', (stall, id, windowEnd) => {
    expect(replayTail(stall)).toEqual([{ connectionId: id, windowEnd }])
  })

  it('lets one peer with a slow statement of its own block a tail retirement', async () => {
    const noisy = pool([
      { name: 'a', statementMs: steady(3) },
      { name: 'noisy', statementMs: withTail(3, 90) },
      { name: 'lossy', statementMs: withTail(3, 415) }
    ])
    await runStatements(noisy.database, 900)

    expect(noisy.destroyed).toEqual([])
  })

  it('never retires, or records, on a pool built without retirement, as cells are', async () => {
    const cell = pool(
      [
        { name: 'a', statementMs: steady(3) },
        { name: 'b', statementMs: steady(3) },
        { name: 'slow', statementMs: steady(55) },
        { name: 'lossy', statementMs: withTail(3, 415) }
      ],
      {}
    )
    await runStatements(cell.database, 1_200)

    expect(cell.destroyed).toEqual([])
    expect(warnings).toEqual([])
  })

  it('drops clients the pool closed on idle, even when nothing else is judged', () => {
    const retirement = new SlowConnectionRetirement(() => clock)
    for (let id = 1; id <= 50; id++) {
      const closedLater = fakeClient()
      retirement.track(closedLater)
      noteConnectionStatement(closedLater, 3)
      retirement.shouldRetire(closedLater, id)
    }
    expect(retirement.trackedClients).toBe(50)

    clock += SLOW_CONNECTION_SAMPLE_MAX_AGE_MS + 1
    const live = fakeClient()
    retirement.track(live)
    noteConnectionStatement(live, 3)
    retirement.shouldRetire(live, 51)
    expect(retirement.trackedClients).toBe(1)
  })

  it('replays the 09:38 stall of 2026-10-26 and retires only its slow connection', () => {
    expect(replay('09:38')).toEqual([{ connectionId: 11, windowEnd: '09:38:21' }])
  })

  it('replays the 09:51 stall, where a second connection (c31, 38 ms) also turned slow', () => {
    expect(replay('09:51')).toEqual([
      { connectionId: 19, windowEnd: '09:51:51' },
      { connectionId: 31, windowEnd: '09:52:51' }
    ])
  })
})

function fakeClient(): pg.PoolClient {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the retirement rule only uses clients as identity keys.
  return {} as pg.PoolClient
}

// Spreads each 30 s window's statements evenly at its median and releases after every statement,
// as autocommit queries do. Stops judging a connection once it is retired.
function replay(stall: '09:38' | '09:51'): { connectionId: number; windowEnd: string }[] {
  const at = (time: string) => Date.parse(`2026-10-26T${time}Z`)
  const samples = DIRECTOR_SLOW_CONNECTION_STALLS.filter(([name]) => name === stall).flatMap(
    ([, windowEnd, connectionId, statements, medianMs]) =>
      Array.from({ length: statements }, (_, index) => ({
        at: at(windowEnd) - 30_000 + ((index + 0.5) * 30_000) / statements,
        windowEnd,
        connectionId,
        medianMs
      }))
  )
  samples.sort((a, b) => a.at - b.at)
  const clients = new Map<number, pg.PoolClient>()
  const retired: { connectionId: number; windowEnd: string }[] = []
  const retirement = new SlowConnectionRetirement(() => clock)
  for (const sample of samples) {
    if (retired.some((entry) => entry.connectionId === sample.connectionId)) {
      continue
    }
    clock = sample.at
    const client = clients.get(sample.connectionId) ?? fakeClient()
    clients.set(sample.connectionId, client)
    retirement.track(client)
    noteConnectionStatement(client, sample.medianMs)
    if (retirement.shouldRetire(client, sample.connectionId)) {
      retired.push({ connectionId: sample.connectionId, windowEnd: sample.windowEnd })
    }
  }
  return retired
}

// Spreads each window's statements evenly at its median, with ceil(1%) of them at its p99 and one at
// its max, and releases after every statement. Stops judging a connection once it is retired.
function replayTail(stall: '14:58' | '15:24'): { connectionId: number; windowEnd: string }[] {
  const at = (time: string) => Date.parse(`2026-10-26T${time}Z`)
  const samples = DIRECTOR_TAIL_CONNECTION_STALLS.filter(([name]) => name === stall).flatMap(
    ([, windowEnd, connectionId, statements, medianMs, p99Ms, maxMs]) => {
      const tailEvery = Math.floor(statements / Math.ceil(statements * 0.01))
      return Array.from({ length: statements }, (_, index) => ({
        at: at(windowEnd) - 30_000 + ((index + 0.5) * 30_000) / statements,
        windowEnd,
        connectionId,
        ms: index === statements - 1 ? maxMs : (index + 1) % tailEvery === 0 ? p99Ms : medianMs
      }))
    }
  )
  samples.sort((a, b) => a.at - b.at)
  const clients = new Map<number, pg.PoolClient>()
  const retired: { connectionId: number; windowEnd: string }[] = []
  const retirement = new SlowConnectionRetirement(() => clock)
  for (const sample of samples) {
    if (retired.some((entry) => entry.connectionId === sample.connectionId)) {
      continue
    }
    clock = sample.at
    const client = clients.get(sample.connectionId) ?? fakeClient()
    clients.set(sample.connectionId, client)
    retirement.track(client)
    noteConnectionStatement(client, sample.ms)
    if (retirement.shouldRetire(client, sample.connectionId)) {
      retired.push({ connectionId: sample.connectionId, windowEnd: sample.windowEnd })
    }
  }
  return retired
}
