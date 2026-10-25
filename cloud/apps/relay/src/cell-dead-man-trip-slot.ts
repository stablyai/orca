import { commitWithFinalWrite, type RelayDatabase } from './database.js'

// A tripped cell refreshes its own row every 15 s unless its pool has waiters, so a slot outlives
// a busy stretch; a cell that died tripped gives its slot back after this.
export const DEAD_MAN_SLOT_HOLD_MS = 10 * 60_000

// A reserve cell's dead-man may trip only while fewer than `slots` other reserve cells are
// tripped, so a director outage moves a bounded number of cells onto their full database pools.
// A slot is held while the cell's own row says db and its switch (relay_cell_admit_modes) still
// says reserve. Only the cell writes that row, so it stays true with every director gone; a
// restarted or re-armed cell writes reserve and frees it.
export async function claimDeadManTripSlot(
  database: RelayDatabase,
  input: { cellId: string; cellIncarnation: string; slots: number; now: number }
): Promise<boolean> {
  return await database.transaction(async (transaction) => {
    // SQLite transactions already run one at a time. On PostgreSQL, concurrent claims would each
    // count the others' uncommitted rows as free; a claim that finds the lock taken retries later.
    if (transaction.dialect === 'postgres') {
      const [lock] = await transaction.query(
        `SELECT pg_try_advisory_xact_lock(hashtext('orca-relay'), hashtext('dead-man-trip-slots')) AS locked`
      )
      if (lock?.locked !== true) {
        return false
      }
    }
    return await commitWithFinalWrite(
      transaction,
      `INSERT INTO relay_cell_admit_effective (cell_id, cell_incarnation, mode, updated_at)
       SELECT ?, ?, 'db', ?
       WHERE (
         SELECT count(*) FROM relay_cell_admit_effective e
         JOIN relay_cell_admit_modes m ON m.cell_id = e.cell_id AND m.admit_mode = 'reserve'
         WHERE e.mode = 'db' AND e.cell_id <> ? AND e.updated_at > ?
       ) < ?
       ON CONFLICT (cell_id) DO UPDATE SET
         cell_incarnation = excluded.cell_incarnation,
         mode = excluded.mode,
         updated_at = excluded.updated_at
       RETURNING cell_id`,
      [
        input.cellId,
        input.cellIncarnation,
        input.now,
        input.cellId,
        input.now - DEAD_MAN_SLOT_HOLD_MS,
        input.slots
      ]
    )
  })
}
