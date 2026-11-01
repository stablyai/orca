import { commitWithFinalWrite, type RelayDatabase } from './database.js'

// Outlive busy refresh gaps, but release the slot of a cell that died while tripped.
export const DEAD_MAN_SLOT_HOLD_MS = 10 * 60_000

// Bound database-pool growth during director outages; cell-owned db rows hold slots until restart, re-arm, or expiry.
export async function claimDeadManTripSlot(
  database: RelayDatabase,
  input: { cellId: string; cellIncarnation: string; slots: number; now: number }
): Promise<boolean> {
  return await database.transaction(async (transaction) => {
    // PostgreSQL claims must serialize to see occupied slots; SQLite already serializes transactions.
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
