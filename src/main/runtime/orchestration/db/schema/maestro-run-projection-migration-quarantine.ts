import { createHash } from 'node:crypto'
import type { OrchestrationDb } from '../orchestration-db'

export type LegacyProjectionRow = {
  home_execution_host_id?: string
  home_workspace_key?: string
  execution_execution_host_id?: string
  execution_workspace_key?: string
  run_id: string
  revision: number
  view_json: string
  updated_at: string
}

export function quarantineMaestroRunProjection(
  database: OrchestrationDb,
  row: LegacyProjectionRow,
  error: unknown
): void {
  const payloadDigest = createHash('sha256').update(row.view_json).digest('hex')
  const quarantineKey = createHash('sha256')
    .update(
      JSON.stringify([
        row.run_id,
        row.revision,
        row.updated_at,
        row.execution_execution_host_id ?? null,
        row.execution_workspace_key ?? null,
        payloadDigest
      ])
    )
    .digest('hex')
  const reason = error instanceof Error ? error.message : 'Stored Maestro projection is invalid.'
  database.db
    .prepare(
      `INSERT OR IGNORE INTO maestro_run_projection_migration_quarantine (
         quarantine_key, run_id, revision, updated_at, reason,
         payload_digest, payload_sample
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      quarantineKey,
      row.run_id,
      row.revision,
      row.updated_at,
      reason.slice(0, 512),
      payloadDigest,
      `sha256:${payloadDigest}`
    )
  console.warn('[orchestration] quarantined malformed Maestro projection during migration', {
    runId: row.run_id,
    revision: row.revision,
    reason
  })
}
