import type { LegacyAdoptionRow } from '../../types'
import { LEGACY_RUN_ID } from '../contract-constants'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'

export function adoptLegacyRunIfNeeded(this: OrchestrationDb): void {
  const existing = this.db
    .prepare('SELECT * FROM legacy_adoptions WHERE source_run_id = ?')
    .get(LEGACY_RUN_ID) as LegacyAdoptionRow | undefined
  const hasGraph = this.db
    .prepare(
      `SELECT 1
       WHERE EXISTS(SELECT 1 FROM tasks WHERE run_id = ?)
          OR EXISTS(SELECT 1 FROM dispatch_contexts WHERE run_id = ?)
          OR EXISTS(SELECT 1 FROM decision_gates WHERE run_id = ?)
          OR EXISTS(SELECT 1 FROM messages WHERE run_id = ?)
          OR EXISTS(SELECT 1 FROM question_threads WHERE run_id = ?)
          OR EXISTS(SELECT 1 FROM deliveries WHERE run_id = ?)`
    )
    .get(LEGACY_RUN_ID, LEGACY_RUN_ID, LEGACY_RUN_ID, LEGACY_RUN_ID, LEGACY_RUN_ID, LEGACY_RUN_ID)
  if (!existing && !hasGraph) {
    return
  }

  const adoptedRunId = existing?.adopted_run_id ?? generateId('run')
  this.db
    .prepare(
      `INSERT OR IGNORE INTO runs (
         id, objective, home_database, consumer_generation, legacy
       ) VALUES (?, ?, 'this_database', 0, 0)`
    )
    .run(adoptedRunId, 'Recovered orchestration work from a contract update')
  this.db
    .prepare(
      `INSERT OR IGNORE INTO legacy_adoptions (
         source_run_id, adopted_run_id, scheduler_state_lost
       ) VALUES (?, ?, 1)`
    )
    .run(LEGACY_RUN_ID, adoptedRunId)
  this.db
    .prepare(
      `UPDATE coordinator_runs
       SET status = 'failed',
           completed_at = COALESCE(
             completed_at,
             (SELECT adopted_at FROM legacy_adoptions WHERE source_run_id = ?)
           ),
           scheduler_lost_at = (
             SELECT adopted_at FROM legacy_adoptions WHERE source_run_id = ?
           )
       WHERE status = 'running'
         AND julianday(created_at) <= julianday((
           SELECT adopted_at FROM legacy_adoptions WHERE source_run_id = ?
         ))`
    )
    .run(LEGACY_RUN_ID, LEGACY_RUN_ID, LEGACY_RUN_ID)

  this.db
    .prepare(
      `UPDATE deliveries SET status = 'fenced'
       WHERE run_id = ? AND status = 'outstanding'`
    )
    .run(LEGACY_RUN_ID)
  for (const table of [
    'tasks',
    'dispatch_contexts',
    'decision_gates',
    'messages',
    'question_threads',
    'deliveries'
  ]) {
    this.db
      .prepare(`UPDATE ${table} SET run_id = ? WHERE run_id = ?`)
      .run(adoptedRunId, LEGACY_RUN_ID)
  }
  this.db
    .prepare(
      `UPDATE runs
       SET objective = 'Legacy orchestration state (adopted; inspect only)',
           coordinator_handle = NULL, coordinator_pane_key = NULL,
           updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(LEGACY_RUN_ID)

  const mismatch = this.db
    .prepare(
      `WITH migration_runs(run_id) AS (VALUES (?), (?))
       SELECT 1
       WHERE EXISTS(
         SELECT 1 FROM dispatch_contexts d
         INNER JOIN tasks t ON t.id = d.task_id
         WHERE d.run_id <> t.run_id
           AND (
             d.run_id IN (SELECT run_id FROM migration_runs)
             OR t.run_id IN (SELECT run_id FROM migration_runs)
           )
       )
          OR EXISTS(
            SELECT 1 FROM decision_gates g
            INNER JOIN tasks t ON t.id = g.task_id
            WHERE g.run_id <> t.run_id
              AND (
                g.run_id IN (SELECT run_id FROM migration_runs)
                OR t.run_id IN (SELECT run_id FROM migration_runs)
              )
          )
          OR EXISTS(
            SELECT 1 FROM question_threads q
            INNER JOIN dispatch_contexts d ON d.id = q.dispatch_id
            WHERE q.run_id <> d.run_id
              AND (
                q.run_id IN (SELECT run_id FROM migration_runs)
                OR d.run_id IN (SELECT run_id FROM migration_runs)
              )
          )
          OR EXISTS(
            SELECT 1 FROM deliveries d
            INNER JOIN json_each(d.message_ids) ids
            INNER JOIN messages m ON m.id = ids.value
            WHERE d.run_id <> m.run_id
              AND (
                d.run_id IN (SELECT run_id FROM migration_runs)
                OR m.run_id IN (SELECT run_id FROM migration_runs)
              )
          )`
    )
    .get(LEGACY_RUN_ID, adoptedRunId)
  if (mismatch) {
    throw new Error('Legacy orchestration adoption produced inconsistent Run ownership.')
  }
}

export type AdoptLegacyRunMethods = {
  adoptLegacyRunIfNeeded: typeof adoptLegacyRunIfNeeded
}

export function attachAdoptLegacyRun(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    adoptLegacyRunIfNeeded
  })
}
