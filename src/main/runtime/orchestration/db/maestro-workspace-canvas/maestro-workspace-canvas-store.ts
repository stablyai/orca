import { createHash } from 'node:crypto'
import {
  WorkspaceCanvasDocumentSchema,
  type WorkspaceCanvasDocument
} from '../../../../../shared/maestro-document-contract'
import { emptyWorkspaceCanvasDocument } from '../../../../../shared/maestro-workspace-document-state'
import type { WorkspaceSurfaceSnapshot } from '../../../../../shared/maestro-workspace-canvas'
import { defaultWorkspaceCanvasPlacement } from './maestro-workspace-default-placement'
import type { OrchestrationDb } from '../orchestration-db'
import { createMaestroWorkspaceCanvasTablesSql } from '../migrations/create-maestro-workspace-canvas-tables-sql'

type WorkspaceCanvasDatabase = Pick<OrchestrationDb, 'db'>
type WorkspaceCanvasScope = { execution_host_id: string; workspace_key: string }
type WorkspaceCanvasRow = {
  revision: number
  last_surface_revision: number
  document_json: string
  updated_at: string
}
type WorkspaceCanvasReceiptRow = { payload_digest: string; receipt_json: string }

export type WorkspaceCanvasDocumentRecord = {
  revision: number
  document: WorkspaceCanvasDocument
  updated_at: string | null
}
export type WorkspaceCanvasWriteReceipt = {
  outcome: 'applied' | 'replayed'
  revision: number
  last_surface_revision: number
}
export type WorkspaceCanvasReconciliationReceipt =
  | WorkspaceCanvasWriteReceipt
  | { outcome: 'stale_surface_snapshot'; revision: number; last_surface_revision: number }

export function readWorkspaceCanvasMutationReceipt<T>(
  database: WorkspaceCanvasDatabase,
  scope: WorkspaceCanvasScope,
  idempotencyKey: string,
  payload: unknown
): T | undefined {
  const row = database.db
    .prepare(
      `SELECT payload_digest, receipt_json FROM maestro_workspace_canvas_receipts
       WHERE execution_host_id = ? AND workspace_key = ? AND idempotency_key = ?`
    )
    .get(scope.execution_host_id, scope.workspace_key, `mutation:${idempotencyKey}`) as
    | WorkspaceCanvasReceiptRow
    | undefined
  if (!row) {
    return undefined
  }
  if (row.payload_digest !== digest(payload)) {
    throw new Error('workspace_canvas_idempotency_conflict')
  }
  return JSON.parse(row.receipt_json) as T
}

export function writeWorkspaceCanvasMutationReceipt<T>(
  database: WorkspaceCanvasDatabase,
  scope: WorkspaceCanvasScope,
  idempotencyKey: string,
  payload: unknown,
  receipt: T
): void {
  database.db
    .prepare(
      `INSERT INTO maestro_workspace_canvas_receipts (
        execution_host_id, workspace_key, idempotency_key, payload_digest, receipt_json
      ) VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      scope.execution_host_id,
      scope.workspace_key,
      `mutation:${idempotencyKey}`,
      digest(payload),
      JSON.stringify(receipt)
    )
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function parseDocument(row: WorkspaceCanvasRow): WorkspaceCanvasDocument {
  const document = WorkspaceCanvasDocumentSchema.parse(JSON.parse(row.document_json))
  if (document.last_surface_revision !== row.last_surface_revision) {
    throw new Error('Workspace Canvas document surface revision is inconsistent.')
  }
  return document
}

function readRow(
  database: WorkspaceCanvasDatabase,
  scope: WorkspaceCanvasScope
): WorkspaceCanvasRow | undefined {
  return database.db
    .prepare(
      `SELECT revision, last_surface_revision, document_json, updated_at
       FROM maestro_workspace_canvas_documents
       WHERE execution_host_id = ? AND workspace_key = ?`
    )
    .get(scope.execution_host_id, scope.workspace_key) as WorkspaceCanvasRow | undefined
}

export function migrateMaestroWorkspaceCanvasStore(database: WorkspaceCanvasDatabase): void {
  database.db.exec(createMaestroWorkspaceCanvasTablesSql())
}

export function readWorkspaceCanvasDocument(
  database: WorkspaceCanvasDatabase,
  scope: WorkspaceCanvasScope
): WorkspaceCanvasDocumentRecord {
  const row = readRow(database, scope)
  if (!row) {
    return { revision: 0, document: emptyWorkspaceCanvasDocument(), updated_at: null }
  }
  return { revision: row.revision, document: parseDocument(row), updated_at: row.updated_at }
}

function replayReceipt(
  database: WorkspaceCanvasDatabase,
  scope: WorkspaceCanvasScope,
  idempotencyKey: string,
  payloadDigest: string
): WorkspaceCanvasWriteReceipt | undefined {
  const row = database.db
    .prepare(
      `SELECT payload_digest, receipt_json FROM maestro_workspace_canvas_receipts
       WHERE execution_host_id = ? AND workspace_key = ? AND idempotency_key = ?`
    )
    .get(scope.execution_host_id, scope.workspace_key, idempotencyKey) as
    | WorkspaceCanvasReceiptRow
    | undefined
  if (!row) {
    return undefined
  }
  if (row.payload_digest !== payloadDigest) {
    throw new Error('Workspace Canvas idempotency key was reused with another payload.')
  }
  const receipt = JSON.parse(row.receipt_json) as WorkspaceCanvasWriteReceipt
  return { ...receipt, outcome: 'replayed' }
}

export function writeWorkspaceCanvasDocument(
  database: WorkspaceCanvasDatabase,
  params: {
    scope: WorkspaceCanvasScope
    expected_revision: number
    idempotency_key: string
    document: WorkspaceCanvasDocument
  }
): WorkspaceCanvasWriteReceipt {
  const document = WorkspaceCanvasDocumentSchema.parse(params.document)
  const payloadDigest = digest({ expected_revision: params.expected_revision, document })
  database.db.exec('SAVEPOINT maestro_workspace_canvas_write')
  try {
    const replay = replayReceipt(database, params.scope, params.idempotency_key, payloadDigest)
    if (replay) {
      database.db.exec('RELEASE maestro_workspace_canvas_write')
      return replay
    }
    const current = readRow(database, params.scope)
    const currentRevision = current?.revision ?? 0
    if (currentRevision !== params.expected_revision) {
      throw new Error(
        `Workspace Canvas revision conflict: expected ${params.expected_revision}, found ${currentRevision}.`
      )
    }
    const revision = currentRevision + 1
    database.db
      .prepare(
        `INSERT INTO maestro_workspace_canvas_documents (
          execution_host_id, workspace_key, revision, last_surface_revision, document_json
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(execution_host_id, workspace_key) DO UPDATE SET
          revision = excluded.revision,
          last_surface_revision = excluded.last_surface_revision,
          document_json = excluded.document_json,
          updated_at = datetime('now')`
      )
      .run(
        params.scope.execution_host_id,
        params.scope.workspace_key,
        revision,
        document.last_surface_revision,
        JSON.stringify(document)
      )
    const receipt: WorkspaceCanvasWriteReceipt = {
      outcome: 'applied',
      revision,
      last_surface_revision: document.last_surface_revision
    }
    database.db
      .prepare(
        `INSERT INTO maestro_workspace_canvas_receipts (
          execution_host_id, workspace_key, idempotency_key, payload_digest, receipt_json
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        params.scope.execution_host_id,
        params.scope.workspace_key,
        params.idempotency_key,
        payloadDigest,
        JSON.stringify(receipt)
      )
    database.db.exec('RELEASE maestro_workspace_canvas_write')
    return receipt
  } catch (error) {
    database.db.exec('ROLLBACK TO maestro_workspace_canvas_write')
    database.db.exec('RELEASE maestro_workspace_canvas_write')
    throw error
  }
}

function reconcileDocument(params: {
  document: WorkspaceCanvasDocument
  snapshot: WorkspaceSurfaceSnapshot
  confirmedClosedSurfaceKeys: readonly string[]
}): { outcome: 'applied' | 'stale'; document: WorkspaceCanvasDocument } {
  if (params.snapshot.authority_revision < params.document.last_surface_revision) {
    return { outcome: 'stale', document: params.document }
  }
  const next = structuredClone(params.document)
  next.last_surface_revision = params.snapshot.authority_revision
  if (params.snapshot.state !== 'ready') {
    return { outcome: 'applied', document: next }
  }
  const confirmedClosed = new Set(params.confirmedClosedSurfaceKeys)
  for (const surfaceKey of confirmedClosed) {
    delete next.placements[surfaceKey]
    delete next.annotations[surfaceKey]
  }
  next.manual_links = next.manual_links.filter(
    (link) =>
      !confirmedClosed.has(link.source_surface_key) && !confirmedClosed.has(link.target_surface_key)
  )
  next.suggestion_decisions = Object.fromEntries(
    Object.entries(next.suggestion_decisions).filter(([, decision]) => {
      const link = decision.accepted_link
      return (
        !link ||
        (!confirmedClosed.has(link.source_surface_key) &&
          !confirmedClosed.has(link.target_surface_key))
      )
    })
  )
  const knownKeys = new Set(Object.keys(next.placements))
  const newSurfaceKeys = Object.keys(params.snapshot.surfaces)
    .filter((key) => !knownKeys.has(key) && !confirmedClosed.has(key))
    .sort()
  for (const surfaceKey of newSurfaceKeys) {
    next.placements[surfaceKey] = defaultWorkspaceCanvasPlacement(
      Object.keys(next.placements).length,
      params.snapshot.surfaces[surfaceKey]!
    )
  }
  return { outcome: 'applied', document: WorkspaceCanvasDocumentSchema.parse(next) }
}

export function reconcileStoredWorkspaceCanvas(
  database: WorkspaceCanvasDatabase,
  params: {
    scope: WorkspaceCanvasScope
    expected_revision: number
    idempotency_key: string
    snapshot: WorkspaceSurfaceSnapshot
    confirmed_closed_surface_keys?: readonly string[]
  }
): WorkspaceCanvasReconciliationReceipt {
  if (
    params.snapshot.execution_host_id !== params.scope.execution_host_id ||
    params.snapshot.workspace_key !== params.scope.workspace_key
  ) {
    throw new Error('Workspace Canvas snapshot does not match the exact document scope.')
  }
  const current = readWorkspaceCanvasDocument(database, params.scope)
  if (current.revision !== params.expected_revision) {
    throw new Error(
      `Workspace Canvas revision conflict: expected ${params.expected_revision}, found ${current.revision}.`
    )
  }
  const reconciliation = reconcileDocument({
    document: current.document,
    snapshot: params.snapshot,
    confirmedClosedSurfaceKeys: params.confirmed_closed_surface_keys ?? []
  })
  if (reconciliation.outcome === 'stale') {
    return {
      outcome: 'stale_surface_snapshot',
      revision: current.revision,
      last_surface_revision: current.document.last_surface_revision
    }
  }
  return writeWorkspaceCanvasDocument(database, {
    scope: params.scope,
    expected_revision: params.expected_revision,
    idempotency_key: params.idempotency_key,
    document: reconciliation.document
  })
}
