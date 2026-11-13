import { afterEach, describe, expect, it, vi } from 'vitest'
import { openInMemoryRelayDatabase, type RelayDatabase } from '../../database/database.js'
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

  it('persists a booked join after a database stall', async () => {
    let now = 1_000
    const { database: db, writer } = await setup(() => now)
    vi.spyOn(db, 'query').mockRejectedValueOnce(new Error('timeout'))
    writer.enqueue({ ...HOST, cellId: 'c1', epoch: 5 })
    await writer.flush()
    now += 1_000
    await writer.flush()
    expect(await row(db)).toMatchObject({ cell_id: 'c1', assignment_epoch: 5 })
  })

  it('reconciles the map’s seats and never lowers an epoch', async () => {
    const { database: db, writer } = await setup()
    writer.enqueue({ ...HOST, cellId: 'c7', epoch: 9 })
    await writer.flush()
    writer.enqueue({ ...HOST, cellId: 'c1', epoch: 9 })
    await writer.flush()
    const other = { userId: 'user-2', relayHostId: 'cccccccccccccccc' }
    const demoted: unknown[] = []
    const result = await reconcileReserveLedger({
      writer,
      seats: () => [
        { ...HOST, cellId: 'c1', epoch: 8, joinedAt: 0 },
        { ...other, cellId: 'c1', epoch: 2, joinedAt: 0 },
        { userId: 'user-3', relayHostId: 'dddddddddddddddd', cellId: 'c1', epoch: 2, joinedAt: 990_000 }
      ],
      demote: (seat) => demoted.push(seat),
      now: 1_000_000
    })
    await writer.flush()
    expect(result).toEqual({ upserted: 1, demoted: 1 })
    expect(demoted).toEqual([{ ...HOST, cellId: 'c1', epoch: 8, joinedAt: 0 }])
    expect(await row(db)).toMatchObject({ cell_id: 'c7', assignment_epoch: 9 })
    const written = await db.query(`SELECT cell_id FROM relay_assignments WHERE user_id = 'user-2'`)
    expect(written).toEqual([{ cell_id: 'c1' }])
  })

  it('demotes a seat level with its row on another cell, which the mirror would never replace', async () => {
    const { database: db, writer } = await setup()
    writer.enqueue({ ...HOST, cellId: 'c7', epoch: 9 })
    writer.enqueue({ ...HOST, relayHostId: 'eeeeeeeeeeeeeeee', cellId: 'c7', epoch: 9 })
    await writer.flush()
    const demoted: unknown[] = []
    const result = await reconcileReserveLedger({
      writer,
      seats: () => [
        { ...HOST, cellId: 'c1', epoch: 9, joinedAt: 0 },
        { ...HOST, relayHostId: 'eeeeeeeeeeeeeeee', cellId: 'c7', epoch: 9, joinedAt: 0 }
      ],
      demote: (seat, found) => demoted.push({ seat: seat.cellId, row: found }),
      now: 1_000_000
    })
    expect(result).toEqual({ upserted: 0, demoted: 1 })
    expect(demoted).toEqual([{ seat: 'c1', row: { cellId: 'c7', epoch: 9 } }])
    await writer.flush()
    expect(await row(db, 'eeeeeeeeeeeeeeee')).toMatchObject({ cell_id: 'c7', assignment_epoch: 9 })
  })
})
