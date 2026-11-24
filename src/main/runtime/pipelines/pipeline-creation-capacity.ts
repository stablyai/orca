import type Database from '../../sqlite/sync-database'

export function assertPipelineCreationCapacity(db: Database.Database): void {
  const active = db
    .prepare(`SELECT
    (SELECT count(*) FROM pipeline_runs WHERE json_extract(data, '$.state') NOT IN ('ready_for_review', 'failed')) +
    (SELECT count(*) FROM pipeline_runs_v2 WHERE json_extract(data, '$.state') NOT IN ('completed', 'failed')) +
    (SELECT count(*) FROM pipeline_creations_v2 WHERE run_id IS NULL) AS count`)
    .get()
  if (Number(active?.count) >= 50) {
    throw new Error('pipeline_active_run_limit')
  }
}
