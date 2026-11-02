import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openRelayDatabase, type RelayDatabase } from './database.js'
import { reconcileReserveLedger, ReserveLedgerWriter } from './reserve-ledger-writer.js'

// The ledger's statements on real PostgreSQL: the guarded upsert, its counter reset on a
// move, and the batched row read.

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip
const USER = `ledger-pg-${randomUUID().slice(0, 8)}`

describePostgres('reserve ledger writer on PostgreSQL', () => {
  let database: RelayDatabase

  beforeAll(async () => {
    database = await openRelayDatabase({ databaseUrl, dataDir: '/tmp' })
  })

  afterAll(async () => {
    await database.query(`DELETE FROM relay_assignments WHERE user_id = ?`, [USER])
    await database.close()
  })

  const row = async (relayHostId: string) =>
    (
      await database.query(
        `SELECT cell_id, assignment_epoch, reserved_controls FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [USER, relayHostId]
      )
    )[0]

  it('writes only a higher epoch, drops a moved row’s counters, and reconciles from the map', async () => {
    const writer = new ReserveLedgerWriter(database, { log: () => undefined })
    const host = 'ledgerpghost0001'
    writer.enqueue({ userId: USER, relayHostId: host, cellId: 'c1', epoch: 5 })
    await writer.flush()
    expect(await row(host)).toMatchObject({ cell_id: 'c1', assignment_epoch: '5' })
    await database.query(`UPDATE relay_assignments SET reserved_controls = 2 WHERE user_id = ?`, [USER])
    writer.enqueue({ userId: USER, relayHostId: host, cellId: 'c2', epoch: 5 })
    await writer.flush()
    expect(await row(host)).toMatchObject({ cell_id: 'c1', assignment_epoch: '5', reserved_controls: '2' })
    writer.enqueue({ userId: USER, relayHostId: host, cellId: 'c2', epoch: 6 })
    await writer.flush()
    expect(await row(host)).toMatchObject({ cell_id: 'c2', assignment_epoch: '6', reserved_controls: '0' })
    const other = 'ledgerpghost0002'
    const result = await reconcileReserveLedger({
      writer,
      seats: () => [
        { userId: USER, relayHostId: host, cellId: 'c1', epoch: 4, joinedAt: 0 },
        { userId: USER, relayHostId: other, cellId: 'c1', epoch: 2, joinedAt: 0 }
      ],
      now: 1_000_000
    })
    await writer.flush()
    expect(result).toEqual({ upserted: 1, demoted: 0 })
    expect(await row(host)).toMatchObject({ cell_id: 'c2', assignment_epoch: '6' })
    expect(await row(other)).toMatchObject({ cell_id: 'c1', assignment_epoch: '2' })
  })
})
