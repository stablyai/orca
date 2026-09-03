import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import { reconcileCellAdmissionAtStartup } from './cell-admission-startup.js'
import type { RelayCellConfig } from './config.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip
const schema = 'relay_startup_retry_test'
const cell: RelayCellConfig = {
  id: 'startup-retry-cell',
  url: 'https://startup-retry.example.test',
  capacityRequests: 4_000
}

afterEach(() => vi.restoreAllMocks())

describePostgres('PostgreSQL director startup reconciliation', () => {
  const databases: RelayDatabase[] = []
  let scopedDatabaseUrl = ''

  beforeAll(async () => {
    const client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await client.query(`CREATE SCHEMA ${schema}`)
    } finally {
      await client.end()
    }
    const url = new URL(databaseUrl!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    scopedDatabaseUrl = url.toString()
    databases.push(
      await openRelayDatabase({ databaseUrl: scopedDatabaseUrl, dataDir: '' }),
      await openRelayDatabase({ databaseUrl: scopedDatabaseUrl, dataDir: '' })
    )
  })

  afterAll(async () => {
    for (const database of databases) await database.close()
    const client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    } finally {
      await client.end()
    }
  })

  it('recovers after the cell inventory lock outlasts transaction retries', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = new RelayAssignmentStore(databases[0]!, () => 100)
    await store.reconcileCells([cell], false)
    let releaseLock: () => void = () => undefined
    let reportLocked: () => void = () => undefined
    const lockReleased = new Promise<void>((resolve) => (releaseLock = resolve))
    const lockAcquired = new Promise<void>((resolve) => (reportLocked = resolve))
    const holder = databases[1]!.transaction(async (transaction) => {
      await transaction.queryLocked(`SELECT cell_id FROM relay_cells ORDER BY cell_id ASC`)
      reportLocked()
      await lockReleased
    })
    await lockAcquired

    const releaseTimer = setTimeout(releaseLock, 3_500)
    try {
      await reconcileCellAdmissionAtStartup({ role: 'director', cells: [cell] }, store)
    } finally {
      clearTimeout(releaseTimer)
      releaseLock()
      await holder
    }

    expect(await databases[0]!.query(`SELECT cell_id FROM relay_cells`)).toEqual([
      { cell_id: cell.id }
    ])
    const warnings = warn.mock.calls.flat().join('\n')
    expect(warnings).toContain('orca_relay_startup_reconcile_recovered')
    expect(warnings).not.toContain('orca_relay_postgres_transaction_exhausted')
  }, 10_000)
})
