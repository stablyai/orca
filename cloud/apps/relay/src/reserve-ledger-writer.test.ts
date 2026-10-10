import { afterEach, describe, expect, it, vi } from 'vitest'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'
import { reconcileReserveLedger, ReserveLedgerWriter } from './reserve-ledger-writer.js'

const HOST = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }

describe('reserve ledger writer', () => {
  let database: RelayDatabase | undefined

  afterEach(async () => {
    await database?.close()
    database = undefined
  })

  async function setup(now = () => 1_000) {
    database = await openInMemoryRelayDatabase()
    return { database, writer: new ReserveLedgerWriter(database, { now, log: () => undefined }) }
  }

  const row = async (db: RelayDatabase, relayHostId = HOST.relayHostId) =>
    (
      await db.query(
        `SELECT cell_id, assignment_epoch, reserved_controls FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [HOST.userId, relayHostId]
      )
    )[0]

  it('writes a booked join, and only a higher epoch replaces it', async () => {
    const { database: db, writer } = await setup()
    writer.enqueue({ ...HOST, cellId: 'c1', epoch: 5 })
    await writer.flush()
    expect(await row(db)).toMatchObject({ cell_id: 'c1', assignment_epoch: 5 })
    writer.enqueue({ ...HOST, cellId: 'c2', epoch: 4 })
    writer.enqueue({ ...HOST, cellId: 'c3', epoch: 5 })
    await writer.flush()
    expect(await row(db)).toMatchObject({ cell_id: 'c1', assignment_epoch: 5 })
    writer.enqueue({ ...HOST, cellId: 'c2', epoch: 6 })
    await writer.flush()
    expect(await row(db)).toMatchObject({ cell_id: 'c2', assignment_epoch: 6 })
  })

  it('lets only a demotion winner replace an equal epoch', async () => {
    const { database: db, writer } = await setup()
    writer.enqueue({ ...HOST, cellId: 'c1', epoch: 5 })
    await writer.flush()
    writer.enqueue({ ...HOST, cellId: 'c2', epoch: 5, allowEqual: true })
    await writer.flush()
    expect(await row(db)).toMatchObject({ cell_id: 'c2', assignment_epoch: 5 })
  })

  it('drops a moved row’s counters but keeps a same-cell row’s', async () => {
    const { database: db, writer } = await setup()
    await db.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at, last_activity_at,
        reserved_controls, reserved_splices, reserved_invites, pending_installs,
        pending_confirmations, migration_leases)
       VALUES (?, ?, 'c1', 3, 0, 0, 2, 0, 0, 0, 0, 0), (?, ?, 'c1', 3, 0, 0, 2, 0, 0, 0, 0, 0)`,
      [HOST.userId, HOST.relayHostId, HOST.userId, 'bbbbbbbbbbbbbbbb']
    )
    writer.enqueue({ ...HOST, cellId: 'c9', epoch: 4 })
    writer.enqueue({ userId: HOST.userId, relayHostId: 'bbbbbbbbbbbbbbbb', cellId: 'c1', epoch: 4 })
    await writer.flush()
    expect(await row(db)).toMatchObject({ cell_id: 'c9', reserved_controls: 0 })
    expect(await row(db, 'bbbbbbbbbbbbbbbb')).toMatchObject({ cell_id: 'c1', reserved_controls: 2 })
  })

  it('keeps its queue through a database stall and drops the oldest past the bound', async () => {
    let now = 1_000
    const { database: db, writer } = await setup(() => now)
    const query = vi.spyOn(db, 'query').mockRejectedValueOnce(new Error('timeout'))
    writer.enqueue({ ...HOST, cellId: 'c1', epoch: 5 })
    await writer.flush()
    expect(writer.pending()).toBe(1)
    // Backoff: no retry before it is due.
    await writer.flush()
    expect(query).toHaveBeenCalledTimes(1)
    now += 1_000
    await writer.flush()
    expect(writer.pending()).toBe(0)
    expect(await row(db)).toMatchObject({ cell_id: 'c1', assignment_epoch: 5 })

    const bounded = new ReserveLedgerWriter(db, { queueMax: 2, log: () => undefined })
    for (const epoch of [1, 2, 3]) bounded.enqueue({ ...HOST, cellId: 'c1', epoch })
    expect(bounded.pending()).toBe(2)
  })

  it('reconciles the map’s seats, and corrects a row that names a placement never used', async () => {
    const { database: db, writer } = await setup()
    // Today's path answered at a higher epoch on c7; the desktop used the booking on c1.
    writer.enqueue({ ...HOST, cellId: 'c7', epoch: 9 })
    await writer.flush()
    const other = { userId: 'user-2', relayHostId: 'cccccccccccccccc' }
    const result = await reconcileReserveLedger({
      writer,
      seats: () => [
        { ...HOST, cellId: 'c1', epoch: 8, joinedAt: 0 },
        { ...other, cellId: 'c1', epoch: 2, joinedAt: 0 },
        // Too young to judge: its duplicate may still be settling.
        { userId: 'user-3', relayHostId: 'dddddddddddddddd', cellId: 'c1', epoch: 2, joinedAt: 990_000 }
      ],
      cellDoesNotSeat: (cellId) => cellId === 'c7',
      now: 1_000_000
    })
    await writer.flush()
    expect(result).toEqual({ upserted: 1, corrected: 1 })
    expect(await row(db)).toMatchObject({ cell_id: 'c1', assignment_epoch: 8 })
    const written = await db.query(`SELECT cell_id FROM relay_assignments WHERE user_id = 'user-2'`)
    expect(written).toEqual([{ cell_id: 'c1' }])
  })

  it('leaves a row alone when the cell it names may still seat the host', async () => {
    const { database: db, writer } = await setup()
    writer.enqueue({ ...HOST, cellId: 'c7', epoch: 9 })
    await writer.flush()
    await reconcileReserveLedger({
      writer,
      seats: () => [{ ...HOST, cellId: 'c1', epoch: 8, joinedAt: 0 }],
      cellDoesNotSeat: () => false,
      now: 1_000_000
    })
    expect(await row(db)).toMatchObject({ cell_id: 'c7', assignment_epoch: 9 })
  })
})
