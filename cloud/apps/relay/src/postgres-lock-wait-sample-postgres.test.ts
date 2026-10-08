import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'
import { readPostgresLockWaitSample } from './postgres-lock-wait-sample.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

const cell = {
  id: 'lock-wait-sample-cell',
  url: 'https://lock-wait-sample.example.com',
  capacityRequests: 10
}

// The split rests on application_name surviving into pg_stat_activity for both
// the waiter and its blocker, which only a real server shows.
describePostgres('PostgreSQL lock-wait sample', () => {
  let cellDatabase: RelayDatabase
  let directorDatabase: RelayDatabase

  beforeAll(async () => {
    cellDatabase = await openRelayDatabase({
      databaseUrl,
      dataDir: '',
      applicationName: `orca-relay/cell/${cell.id}`
    })
    directorDatabase = await openRelayDatabase({
      databaseUrl,
      dataDir: '',
      applicationName: 'orca-relay/director/director'
    })
    await new RelayAssignmentStore(directorDatabase).reconcileCells([cell])
  })

  afterAll(async () => {
    await directorDatabase?.query(`DELETE FROM relay_cells WHERE cell_id = ?`, [cell.id])
    await cellDatabase?.close()
    await directorDatabase?.close()
  })

  // Every waiter after the first is blocked by the first waiter's tuple lock, so
  // only the root of the chain names the cell transaction that holds the row.
  it('attributes a convoy of directors to the cell holding the relay_cells row', async () => {
    expect(await readPostgresLockWaitSample(directorDatabase)).toEqual([])

    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let held!: () => void
    const holding = new Promise<void>((resolve) => (held = resolve))
    const holder = cellDatabase.transaction(async (transaction) => {
      await transaction.query(
        `UPDATE relay_cells SET reserved_requests = reserved_requests WHERE cell_id = ?`,
        [cell.id]
      )
      held()
      await released
    })
    await holding
    const waiters = Array.from({ length: 3 }, () =>
      directorDatabase.transaction(async (transaction) => {
        await transaction.queryLocked(`SELECT * FROM relay_cells WHERE cell_id = ?`, [cell.id])
      })
    )

    try {
      await expect
        .poll(async () => await readPostgresLockWaitSample(directorDatabase), { timeout: 900 })
        .toEqual([
          { waiterRole: 'director', table: 'relay_cells', holderRole: 'cell', waiters: 3 }
        ])
    } finally {
      release()
      await Promise.all([holder, ...waiters])
    }
  })
})
