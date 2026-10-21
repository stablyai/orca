import { isEquivalentPaneKey } from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'

// Real user input durably relinquishes orchestration ownership.
export function markWorkerTerminalUserOwned(this: OrchestrationDb, paneKey: string): number {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const exact = this.db
      .prepare(
        `SELECT id, owner_dispatch_id, pane_key FROM worker_terminal_resources
          WHERE pane_key = ? AND ownership_state = 'owned'
            AND release_state IN ('not_requested', 'retained', 'requested')
            AND NOT EXISTS (
              SELECT 1 FROM worker_dispatches w
               WHERE w.dispatch_id = owner_dispatch_id AND w.state = 'stopping'
            )`
      )
      .all(paneKey) as { id: string; owner_dispatch_id: string; pane_key: string }[]
    const candidates =
      exact.length > 0
        ? exact
        : (
            this.db
              .prepare(
                `SELECT id, owner_dispatch_id, pane_key FROM worker_terminal_resources
                WHERE ownership_state = 'owned'
                  AND release_state IN ('not_requested', 'retained', 'requested')
                  AND NOT EXISTS (
                    SELECT 1 FROM worker_dispatches w
                     WHERE w.dispatch_id = owner_dispatch_id AND w.state = 'stopping'
                  )
                  AND pane_key IS NOT NULL`
              )
              .all() as { id: string; owner_dispatch_id: string; pane_key: string }[]
          ).filter((candidate) => isEquivalentPaneKey(candidate.pane_key, paneKey))
    const update = this.db.prepare(
      `UPDATE worker_terminal_resources
       SET ownership_state = 'user_owned', release_state = 'retained',
           retained_reason = 'user_takeover', updated_at = datetime('now')
       WHERE id = ? AND ownership_state = 'owned'
         AND release_state IN ('not_requested', 'retained', 'requested')
         AND NOT EXISTS (
           SELECT 1 FROM worker_dispatches w
            WHERE w.dispatch_id = owner_dispatch_id AND w.state = 'stopping'
         )`
    )
    let changed = 0
    for (const candidate of candidates) {
      const result = Number(update.run(candidate.id).changes)
      if (result > 0) {
        this.db
          .prepare('DELETE FROM worker_terminal_archives WHERE dispatch_id = ?')
          .run(candidate.owner_dispatch_id)
        changed += result
      }
    }
    this.db.exec('COMMIT')
    return changed
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}
