import type { OrchestrationDb } from '../db/orchestration-db'

const state = 'orchestration_projection_state'
const dirty = 'orchestration_projection_dirty'
const MIN_CANDIDATE_CAPACITY = 64

export const projectionDebtSchema = `CREATE TEMP TABLE IF NOT EXISTS ${state}(
  id INTEGER PRIMARY KEY CHECK(id = 1), queued INTEGER NOT NULL,
  capacity INTEGER NOT NULL, rebuild INTEGER NOT NULL);
  INSERT OR IGNORE INTO ${state} VALUES(1, 0, ${MIN_CANDIDATE_CAPACITY}, 0);`

export function markProjectionCandidate(row: string): string {
  return `INSERT OR IGNORE INTO ${dirty}(key)
    SELECT 'candidate:' || ${row}.id FROM ${state} WHERE id = 1 AND rebuild = 0;
    UPDATE ${state} SET queued = queued + changes(),
      rebuild = (queued + changes() > capacity) WHERE id = 1 AND rebuild = 0;`
}

export function projectionNeedsRebuild(db: OrchestrationDb): boolean {
  return db.db.prepare(`SELECT rebuild FROM temp.${state} WHERE id = 1`).get()?.rebuild === 1
}

/** Retire debt only after current source facts have loaded successfully. */
export function acknowledgeProjectionDebt(db: OrchestrationDb, candidates: number): void {
  db.db.exec('SAVEPOINT orchestration_projection_ack')
  try {
    db.db.prepare(`DELETE FROM temp.${dirty}`).run()
    db.db
      .prepare(`UPDATE temp.${state} SET queued = 0, rebuild = 0, capacity = ? WHERE id = 1`)
      .run(Math.max(MIN_CANDIDATE_CAPACITY, candidates))
    db.db.exec('RELEASE orchestration_projection_ack')
  } catch (error) {
    db.db.exec('ROLLBACK TO orchestration_projection_ack')
    db.db.exec('RELEASE orchestration_projection_ack')
    throw error
  }
}
