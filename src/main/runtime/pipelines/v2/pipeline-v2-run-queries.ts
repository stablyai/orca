import type Database from '../../../sqlite/sync-database'
import { PipelineV2Run } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'

export function pipelineV2RunPage(
  db: Database.Database,
  projectId: string,
  cursor: number,
  limit: number
) {
  const rows = db
    .prepare(
      "SELECT rowid,data FROM pipeline_runs_v2 WHERE json_extract(data,'$.workspace.projectId')=? AND rowid>? ORDER BY rowid LIMIT ?"
    )
    .all(projectId, cursor, limit + 1)
  return rows.map((row) => ({
    cursor: Number(row.rowid),
    run: PipelineV2Run.parse(JSON.parse(String(row.data)))
  }))
}
