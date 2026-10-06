import pg from 'pg'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import type { RelayCellConfig } from './config.js'
import {
  openInMemoryRelayDatabase,
  openRelayDatabase,
  type RelayDatabase,
  type SqlRow
} from './database.js'

// The sweep's host query walked every assignment by primary key to return nothing while stale
// existing-only cells sat in the fleet. These pin that a fleet with nothing to evacuate never
// reaches it, and that a cell the sweep can act on still does, on both dialects.
const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const schema = 'relay_dead_cell_precheck_test'
const HOST_QUERY = 'FROM relay_assignments assignment'
const CELLS: RelayCellConfig[] = [
  { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
  { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
]

class RecordingDatabase implements RelayDatabase {
  readonly statements: string[] = []

  constructor(private readonly delegate: RelayDatabase) {}

  get dialect() {
    return this.delegate.dialect
  }

  async query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    this.statements.push(sql)
    return await this.delegate.query(sql, params)
  }

  async queryLocked(...args: Parameters<RelayDatabase['queryLocked']>): Promise<SqlRow[]> {
    return await this.delegate.queryLocked(...args)
  }

  async transaction<T>(operation: (transaction: RelayDatabase) => Promise<T>): Promise<T> {
    return await this.delegate.transaction(operation)
  }

  async close(): Promise<void> {
    await this.delegate.close()
  }
}

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

const dialects: [string, () => Promise<RelayDatabase>][] = [
  ['sqlite', openInMemoryRelayDatabase],
  ...(databaseUrl
    ? [
        [
          'postgres',
          async () => {
            await onAdmin(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
            await onAdmin(`CREATE SCHEMA ${schema}`)
            return await openRelayDatabase({ databaseUrl: scopedUrl(), dataDir: '' })
          }
        ] as [string, () => Promise<RelayDatabase>]
      ]
    : [])
]

describe.each(dialects)('dead-cell evacuation pre-check (%s)', (_dialect, open) => {
  let database: RelayDatabase | undefined

  afterEach(async () => {
    await database?.close()
    database = undefined
  })

  afterAll(async () => {
    if (databaseUrl) await onAdmin(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  })

  async function setup(now: () => number) {
    database = await open()
    const recording = new RecordingDatabase(database)
    const store = new RelayAssignmentStore(recording, now, {
      requireLiveCells: true,
      heartbeatTtlMs: 45_000
    })
    await store.reconcileCells(CELLS)
    return { store, recording }
  }

  async function heartbeat(store: RelayAssignmentStore, cell: RelayCellConfig): Promise<void> {
    await store.recordCellHeartbeat({
      cellId: cell.id,
      cellUrl: cell.url,
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      startedAt: 50,
      ready: true,
      observedRequests: 0
    })
  }

  it('skips the host query when the only dead cell is unfenced and existing-only', async () => {
    let now = 100
    const { store, recording } = await setup(() => now)
    for (const cell of CELLS) await heartbeat(store, cell)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    await store.setCellEnabled('cell-b', false)
    expect(await store.assign(identity)).toMatchObject({ cellId: 'cell-a' })
    await store.setCellEnabled('cell-b', true)
    await store.setCellEnabled('cell-a', false)
    now += 45_001
    await heartbeat(store, CELLS[1]!)
    recording.statements.length = 0

    expect(await store.evacuateDeadCells()).toBe(0)
    expect(recording.statements.some((sql) => sql.includes(HOST_QUERY))).toBe(false)
    expect(
      await database!.query(`SELECT cell_id FROM relay_assignments WHERE user_id = ?`, [
        identity.userId
      ])
    ).toEqual([{ cell_id: 'cell-a' }])
  })

  it('still evacuates hosts from a dead uncapped cell that admits', async () => {
    let now = 100
    const { store, recording } = await setup(() => now)
    for (const cell of CELLS) await heartbeat(store, cell)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    await store.setCellEnabled('cell-b', false)
    expect(await store.assign(identity)).toMatchObject({ cellId: 'cell-a' })
    await store.setCellEnabled('cell-b', true)
    now += 45_001
    await heartbeat(store, CELLS[1]!)
    recording.statements.length = 0

    expect(await store.evacuateDeadCells()).toBe(1)
    expect(recording.statements.some((sql) => sql.includes(HOST_QUERY))).toBe(true)
    expect((await store.resolve(identity))?.cellId).toBe('cell-b')
  })
})
