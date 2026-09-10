import {
  MaestroBootstrapReceiptSchema,
  MaestroBootstrapRequestSchema,
  type MaestroBootstrapReceipt,
  type MaestroBootstrapRequest
} from '../../../../../shared/maestro-bootstrap-contract'
import {
  parseAgentGraphView,
  type AgentGraphView,
  type MaestroDocumentReadScope
} from '../../../../../shared/maestro-contract'
import type { OrchestrationDb } from '../orchestration-db'

const MAX_PROJECTION_RUNS = 128

type ProjectionRow = {
  view_json: string
  updated_at: string
}

type BootstrapRecordRow = {
  request_json: string
  receipt_json: string
}

export type StoredMaestroProjection = { view: AgentGraphView; updatedAt: string }
export type StoredMaestroBootstrap = {
  request: MaestroBootstrapRequest
  receipt: MaestroBootstrapReceipt
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`Stored Maestro ${label} is invalid JSON.`)
  }
}

function parseProjectionRow(row: ProjectionRow): StoredMaestroProjection {
  return {
    view: parseAgentGraphView(parseJson(row.view_json, 'projection')),
    updatedAt: row.updated_at
  }
}

function parseBootstrapRow(row: BootstrapRecordRow): StoredMaestroBootstrap {
  return {
    request: MaestroBootstrapRequestSchema.parse(parseJson(row.request_json, 'bootstrap request')),
    receipt: MaestroBootstrapReceiptSchema.parse(parseJson(row.receipt_json, 'bootstrap receipt'))
  }
}

export function readStoredMaestroProjection(
  database: OrchestrationDb,
  scope: MaestroDocumentReadScope,
  runId?: string
): StoredMaestroProjection | null {
  const row = database.db
    .prepare(
      `SELECT view_json, updated_at FROM maestro_run_projections
       WHERE (? IS NULL OR run_id = ?) AND (
         (home_execution_host_id = ? AND home_workspace_key = ?) OR
         (execution_execution_host_id = ? AND execution_workspace_key = ?)
       ) ORDER BY updated_at DESC, rowid DESC LIMIT 1`
    )
    .get(
      runId ?? null,
      runId ?? null,
      scope.execution_host_id,
      scope.workspace_key,
      scope.execution_host_id,
      scope.workspace_key
    ) as ProjectionRow | undefined
  return row ? parseProjectionRow(row) : null
}

export function listStoredMaestroProjections(database: OrchestrationDb): StoredMaestroProjection[] {
  const rows = database.db
    .prepare(
      `SELECT view_json, updated_at FROM maestro_run_projections
       ORDER BY updated_at DESC, rowid DESC`
    )
    .all() as ProjectionRow[]
  return rows.map(parseProjectionRow)
}

export function persistMaestroProjectionScopes(
  database: OrchestrationDb,
  view: AgentGraphView,
  scopes: readonly MaestroDocumentReadScope[],
  updatedAt: string
): void {
  const home = view.workspace_scope.orchestration_home
  const execution = view.workspace_scope.execution_workspace
  if (
    scopes.length !== 2 ||
    !scopes.some(
      (scope) =>
        scope.execution_host_id === home.execution_host_id &&
        scope.workspace_key === home.workspace_key
    ) ||
    !scopes.some(
      (scope) =>
        scope.execution_host_id === execution.execution_host_id &&
        scope.workspace_key === execution.workspace_key
    )
  ) {
    throw new Error('Maestro projection aliases do not match the Run workspace scope.')
  }
  database.db.exec('SAVEPOINT maestro_projection_persist')
  try {
    persistProjectionRow(database, view, updatedAt)
    database.db
      .prepare(
        `DELETE FROM maestro_run_projections WHERE rowid IN (
           SELECT rowid FROM maestro_run_projections
           ORDER BY updated_at DESC, rowid DESC LIMIT -1 OFFSET ?
         )`
      )
      .run(MAX_PROJECTION_RUNS)
    database.db.exec('RELEASE maestro_projection_persist')
  } catch (error) {
    database.db.exec('ROLLBACK TO maestro_projection_persist')
    database.db.exec('RELEASE maestro_projection_persist')
    throw error
  }
}

function persistProjectionRow(database: OrchestrationDb, view: AgentGraphView, updatedAt: string) {
  const home = view.workspace_scope.orchestration_home
  const execution = view.workspace_scope.execution_workspace
  database.db
    .prepare(
      `INSERT INTO maestro_run_projections (
         run_id, home_execution_host_id, home_workspace_key,
         execution_execution_host_id, execution_workspace_key,
         revision, view_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         home_execution_host_id = excluded.home_execution_host_id,
         home_workspace_key = excluded.home_workspace_key,
         execution_execution_host_id = excluded.execution_execution_host_id,
         execution_workspace_key = excluded.execution_workspace_key,
         revision = excluded.revision,
         view_json = excluded.view_json,
         updated_at = excluded.updated_at`
    )
    .run(
      view.run_id,
      home.execution_host_id,
      home.workspace_key,
      execution.execution_host_id,
      execution.workspace_key,
      view.revision,
      JSON.stringify(view),
      updatedAt
    )
}

export function readMaestroBootstrapByMutation(
  database: OrchestrationDb,
  mutationId: string
): StoredMaestroBootstrap | null {
  const row = database.db
    .prepare(
      `SELECT request_json, receipt_json FROM maestro_bootstrap_records
       WHERE mutation_id = ?`
    )
    .get(mutationId) as BootstrapRecordRow | undefined
  return row ? parseBootstrapRow(row) : null
}

export function readMaestroBootstrapByWorkspace(
  database: OrchestrationDb,
  scope: MaestroDocumentReadScope & { run_id: string }
): StoredMaestroBootstrap | null {
  const row = database.db
    .prepare(
      `SELECT request_json, receipt_json FROM maestro_bootstrap_records
       WHERE execution_host_id = ? AND workspace_key = ? AND run_id = ?
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(scope.execution_host_id, scope.workspace_key, scope.run_id) as
    | BootstrapRecordRow
    | undefined
  return row ? parseBootstrapRow(row) : null
}

export function persistMaestroBootstrapRecord(
  database: OrchestrationDb,
  request: MaestroBootstrapRequest,
  receipt: MaestroBootstrapReceipt
): void {
  const existing = readMaestroBootstrapByMutation(database, request.mutation.mutation_id)
  if (existing) {
    if (
      JSON.stringify(existing.request) !== JSON.stringify(request) ||
      JSON.stringify(existing.receipt) !== JSON.stringify(receipt)
    ) {
      throw new Error('Maestro bootstrap mutation identity was reused with different input.')
    }
    return
  }
  database.db
    .prepare(
      `INSERT INTO maestro_bootstrap_records (
         mutation_id, execution_host_id, workspace_key, run_id,
         request_json, receipt_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      request.mutation.mutation_id,
      request.mutation.execution_host_id,
      request.mutation.workspace_key,
      request.mutation.run_id,
      JSON.stringify(request),
      JSON.stringify(receipt),
      new Date().toISOString()
    )
}
