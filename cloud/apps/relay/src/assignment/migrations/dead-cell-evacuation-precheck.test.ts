import pg from 'pg'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from '../assignment-store.js'
import type { RelayCellConfig } from '../../config.js'
import {
  openInMemoryRelayDatabase,
  openRelayDatabase,
  type RelayDatabase
} from '../../database/database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const schema = 'relay_dead_cell_precheck_test'
const CELLS: RelayCellConfig[] = [
  { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
  { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
]

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
    const store = new RelayAssignmentStore(database, now, {
      requireLiveCells: true,
      heartbeatTtlMs: 45_000
    })
    await store.reconcileCells(CELLS)
    return { store }
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

  it('still evacuates hosts from a dead uncapped cell that admits', async () => {
    let now = 100
    const { store } = await setup(() => now)
    for (const cell of CELLS) await heartbeat(store, cell)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    await store.setCellEnabled('cell-b', false)
    expect(await store.assign(identity)).toMatchObject({ cellId: 'cell-a' })
    await store.setCellEnabled('cell-b', true)
    now += 45_001
    await heartbeat(store, CELLS[1]!)

    expect(await store.evacuateDeadCells()).toBe(1)
    expect((await store.resolve(identity))?.cellId).toBe('cell-b')
  })
})
