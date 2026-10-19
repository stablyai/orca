import pg from 'pg'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  RelayAssignmentStore,
  RELEASED_CONTROL_RESERVATION_RETENTION_MS
} from './assignment-store.js'
import {
  openInMemoryRelayDatabase,
  openRelayDatabase,
  type RelayDatabase
} from './database.js'
import { HeapWindowReaper } from './heap-window-reaper.js'

// Released reservations were never deleted: 13.7M rows and 9 GB in production, every one of them
// still locked by each placement of its host. These pin what the prune may take and how it walks.
const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip
const schema = 'relay_released_reservation_prune_test'
const NOW = 100 * 24 * 60 * 60 * 1_000
const STALE = NOW - RELEASED_CONTROL_RESERVATION_RETENTION_MS
const PREDICATE = `state = 'released' AND released_at <= ?`

function scopedUrl(): string {
  const url = new URL(databaseUrl!)
  url.searchParams.set('options', `-c search_path=${schema}`)
  return url.toString()
}

async function onAdmin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

async function openPostgres(): Promise<RelayDatabase> {
  await onAdmin(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await onAdmin(`CREATE SCHEMA ${schema}`)
  return await openRelayDatabase({ databaseUrl: scopedUrl(), dataDir: '' })
}

async function insertReservation(
  database: RelayDatabase,
  id: string,
  state: string,
  releasedAt: number | null
): Promise<void> {
  await database.query(
    `INSERT INTO relay_control_connection_reservations
     (reservation_id, idempotency_key, user_id, relay_host_id, assignment_epoch,
      cell_id, state, created_at, timeout_at, released_at, updated_at)
     VALUES (?, ?, 'user-1', 'host000000000001', 1, 'cell-a', ?, 1, 1, ?, 1)`,
    [id, id, state, releasedAt]
  )
}

async function remainingIds(database: RelayDatabase): Promise<string[]> {
  const rows = await database.query(
    `SELECT reservation_id FROM relay_control_connection_reservations ORDER BY reservation_id`
  )
  return rows.map((row) => String(row.reservation_id))
}

const dialects: [string, () => Promise<RelayDatabase>][] = [
  ['sqlite', openInMemoryRelayDatabase],
  ...(databaseUrl ? [['postgres', openPostgres] as [string, () => Promise<RelayDatabase>]] : [])
]

describe.each(dialects)('released reservation prune (%s)', (_dialect, open) => {
  let database: RelayDatabase | undefined

  afterEach(async () => {
    await database?.close()
    database = undefined
  })

  afterAll(async () => {
    if (databaseUrl) await onAdmin(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  })

  it('deletes only released rows older than the retention window', async () => {
    database = await open()
    await insertReservation(database, 'a-old-released', 'released', STALE - 1)
    await insertReservation(database, 'b-edge-released', 'released', STALE)
    await insertReservation(database, 'c-fresh-released', 'released', STALE + 1)
    await insertReservation(database, 'd-reserved', 'reserved', null)
    await insertReservation(database, 'e-debt', 'late-arrival-debt', null)
    await insertReservation(database, 'f-claimed', 'claimed', null)
    // A row that once was released and came back is judged by its state, not its timestamp.
    await insertReservation(database, 'g-claimed-old-release', 'claimed', STALE - 1)
    const store = new RelayAssignmentStore(database, () => NOW)

    expect(await store.pruneReleasedControlReservations()).toBe(2)
    expect(await remainingIds(database)).toEqual([
      'c-fresh-released',
      'd-reserved',
      'e-debt',
      'f-claimed',
      'g-claimed-old-release'
    ])
  })
})

describePostgres('heap window reaper against PostgreSQL', () => {
  let database: RelayDatabase
  // 200 rows of this shape fill about two pages; 6,000 spread the table over ~60 pages.
  const ROWS = 6_000

  afterEach(async () => {
    await database?.close()
  })

  afterAll(async () => {
    await onAdmin(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  })

  async function seed(): Promise<number> {
    database = await openPostgres()
    // Every third row is still live, so each page holds rows the walk must keep.
    await database.query(
      `INSERT INTO relay_control_connection_reservations
       (reservation_id, idempotency_key, user_id, relay_host_id, assignment_epoch,
        cell_id, state, created_at, timeout_at, released_at, updated_at)
       SELECT 'r-' || lpad(n::text, 6, '0'), 'r-' || n, 'user-1', 'host000000000001', 1,
              'cell-a', CASE WHEN n % 3 = 0 THEN 'claimed' ELSE 'released' END,
              1, 1, CASE WHEN n % 3 = 0 THEN NULL ELSE 1 END, 1
       FROM generate_series(1, ?) AS n`,
      [ROWS]
    )
    const pages = (
      await database.query(
        `SELECT pg_relation_size('relay_control_connection_reservations') / 8192 AS pages`
      )
    )[0]!
    return Number(pages.pages)
  }

  it('stops each tick at its row cap and drains the backlog over later ticks', async () => {
    const pages = await seed()
    expect(pages).toBeGreaterThan(20)
    const reaper = new HeapWindowReaper(
      'relay_control_connection_reservations',
      PREDICATE,
      { pagesPerStatement: 2, maxPagesPerTick: 1_000, maxRowsPerTick: 300, budgetMs: 60_000 },
      () => 0.5
    )

    const first = await reaper.reap(database, [NOW])
    // One statement past the cap at most: two pages of this shape hold well under 300 rows.
    expect(first).toBeGreaterThanOrEqual(300)
    expect(first).toBeLessThan(600)

    let ticks = 1
    while ((await reaper.reap(database, [NOW])) > 0) ticks += 1
    expect(ticks).toBeGreaterThan(5)
    const left = await database.query(
      `SELECT state, COUNT(*) AS rows FROM relay_control_connection_reservations GROUP BY state`
    )
    expect(left).toEqual([{ state: 'claimed', rows: String(ROWS / 3) }])
  })

  it('wraps from the end of the heap back to its first page', async () => {
    const pages = await seed()
    // Starts on the last page, so every other page is reached only after the wrap.
    const reaper = new HeapWindowReaper(
      'relay_control_connection_reservations',
      PREDICATE,
      { pagesPerStatement: 4, maxPagesPerTick: pages + 4, maxRowsPerTick: 1_000_000, budgetMs: 60_000 },
      () => (pages - 1) / pages
    )

    await reaper.reap(database, [NOW])

    expect(
      await database.query(
        `SELECT COUNT(*) AS rows FROM relay_control_connection_reservations
         WHERE state = 'released'`
      )
    ).toEqual([{ rows: '0' }])
  })

  it('skips a row a request holds instead of waiting for it', async () => {
    await seed()
    const holder = new pg.Client({ connectionString: scopedUrl() })
    await holder.connect()
    try {
      await holder.query('BEGIN')
      await holder.query(
        `SELECT reservation_id FROM relay_control_connection_reservations
         WHERE reservation_id = 'r-000001' FOR UPDATE`
      )
      const reaper = new HeapWindowReaper(
        'relay_control_connection_reservations',
        PREDICATE,
        { pagesPerStatement: 1_000, maxPagesPerTick: 1_000, maxRowsPerTick: 1_000_000, budgetMs: 60_000 },
        () => 0
      )

      // The pool's lock_timeout would fail this statement if it waited on the held row.
      expect(await reaper.reap(database, [NOW])).toBe((ROWS * 2) / 3 - 1)
      expect(
        await database.query(
          `SELECT reservation_id FROM relay_control_connection_reservations
           WHERE state = 'released'`
        )
      ).toEqual([{ reservation_id: 'r-000001' }])
    } finally {
      await holder.query('ROLLBACK')
      await holder.end()
    }
  })

  it('plans each statement as a TID range scan, never a sequential scan', async () => {
    await seed()
    await database.query('ANALYZE relay_control_connection_reservations')
    const client = new pg.Client({ connectionString: scopedUrl() })
    await client.connect()
    try {
      const plan = await client.query(
        `EXPLAIN DELETE FROM relay_control_connection_reservations WHERE ctid = ANY(ARRAY(
           SELECT ctid FROM relay_control_connection_reservations
           WHERE ctid >= CAST($1 AS tid) AND ctid < CAST($2 AS tid) AND ${PREDICATE.replace('?', '$3')}
           FOR UPDATE SKIP LOCKED))`,
        ['(0,0)', '(16,0)', NOW]
      )
      const text = plan.rows.map((row) => String(row['QUERY PLAN'])).join('\n')
      expect(text).toContain('Tid Range Scan')
      expect(text).not.toContain('Seq Scan')
    } finally {
      await client.end()
    }
  })
})
