import { createHash } from 'node:crypto'
import type {
  MaestroDocument,
  MaestroDocumentReadScope
} from '../../../../../shared/maestro-contract'
import {
  MAX_MAESTRO_DELTAS,
  MAX_MAESTRO_DOCUMENT_BYTES,
  MaestroDocumentSchema
} from '../../../../../shared/maestro-contract'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

export type MaestroDocumentRow = {
  execution_host_id: string
  workspace_key: string
  run_id: string | null
  revision: number
  document_json: string
  updated_at: string
}

export type StoredDocument = MaestroDocument

export type MaestroMutationResult =
  | { outcome: 'applied'; revision: number; affectedIds: string[] }
  | { outcome: 'conflict'; revision: number; resetRequired: true }

export type MaestroDocumentAuthoringMutationResult = MaestroMutationResult

export type AuthoringReceipt = {
  kind: 'authoring'
  result: MaestroDocumentAuthoringMutationResult
  before: MaestroDocument
  after: MaestroDocument
}

export function hashPayload(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function hashDocumentState(document: MaestroDocument): string {
  return hashPayload({ nodes: document.nodes, edges: document.edges, viewport: document.viewport })
}

export function parseStoredDocument(value: string): StoredDocument {
  try {
    return MaestroDocumentSchema.parse(JSON.parse(value))
  } catch (error) {
    throw new OrchestrationError(
      'integrity_error',
      'The durable Maestro document is malformed and cannot be overwritten.',
      error
    )
  }
}

export function authoringReceipt(value: string): AuthoringReceipt | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<AuthoringReceipt>
    return parsed.kind === 'authoring' && parsed.result && parsed.before && parsed.after
      ? (parsed as AuthoringReceipt)
      : undefined
  } catch {
    return undefined
  }
}

export function storedReceiptResult(value: string): MaestroMutationResult {
  const authoring = authoringReceipt(value)
  return authoring?.result ?? (JSON.parse(value) as MaestroMutationResult)
}

export function recordDocumentMutation(
  db: OrchestrationDb,
  scope: MaestroDocumentReadScope,
  mutationId: string,
  payloadHash: string,
  before: MaestroDocument,
  after: MaestroDocument,
  affectedIds: string[]
): MaestroDocumentAuthoringMutationResult {
  const row = documentRow.call(db, scope)
  if (!row) {
    throw new Error('Failed to read the Maestro document after mutation.')
  }
  const revision = row.revision + 1
  const result: MaestroDocumentAuthoringMutationResult = {
    outcome: 'applied',
    revision,
    affectedIds
  }
  const documentJson = JSON.stringify(after)
  if (Buffer.byteLength(documentJson, 'utf8') > MAX_MAESTRO_DOCUMENT_BYTES) {
    throw new OrchestrationError(
      'capacity_exceeded',
      'Maestro document exceeds its bounded capacity.'
    )
  }
  db.db
    .prepare(
      `UPDATE maestro_documents SET revision = ?, document_json = ?, updated_at = datetime('now')
       WHERE execution_host_id = ? AND workspace_key = ?`
    )
    .run(revision, documentJson, scope.execution_host_id, scope.workspace_key)
  db.db
    .prepare(
      `INSERT INTO maestro_deltas (execution_host_id, workspace_key, revision, delta_json) VALUES (?, ?, ?, ?)`
    )
    .run(scope.execution_host_id, scope.workspace_key, revision, JSON.stringify(result))
  db.db
    .prepare(
      `DELETE FROM maestro_deltas WHERE execution_host_id = ? AND workspace_key = ? AND revision <= ?`
    )
    .run(scope.execution_host_id, scope.workspace_key, revision - MAX_MAESTRO_DELTAS)
  db.db
    .prepare(
      `INSERT INTO maestro_mutation_receipts (execution_host_id, workspace_key, mutation_id, payload_hash, receipt_json)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      scope.execution_host_id,
      scope.workspace_key,
      mutationId,
      payloadHash,
      JSON.stringify({ kind: 'authoring', result, before, after })
    )
  return result
}

export function documentRow(
  this: OrchestrationDb,
  scope: Pick<MaestroDocumentReadScope, 'execution_host_id' | 'workspace_key'>
): MaestroDocumentRow | undefined {
  return this.db
    .prepare('SELECT * FROM maestro_documents WHERE execution_host_id = ? AND workspace_key = ?')
    .get(scope.execution_host_id, scope.workspace_key) as MaestroDocumentRow | undefined
}

export function ensureDocument(
  this: OrchestrationDb,
  workspace: Pick<MaestroDocumentReadScope, 'execution_host_id' | 'workspace_key'>,
  runId?: string,
  bindUnboundDocument = false
): MaestroDocumentRow {
  this.db
    .prepare(
      `INSERT OR IGNORE INTO maestro_documents (execution_host_id, workspace_key, run_id)
       VALUES (?, ?, ?)`
    )
    .run(workspace.execution_host_id, workspace.workspace_key, runId ?? null)
  const row = documentRow.call(this, workspace)
  if (!row) {
    throw new Error('Failed to create the Maestro document.')
  }
  if (runId !== undefined && row.run_id === null && bindUnboundDocument) {
    this.db
      .prepare(
        `UPDATE maestro_documents SET run_id = ?
         WHERE execution_host_id = ? AND workspace_key = ? AND run_id IS NULL`
      )
      .run(runId, workspace.execution_host_id, workspace.workspace_key)
    const boundRow = documentRow.call(this, workspace)
    if (!boundRow) {
      throw new Error('Failed to bind the Maestro document to its current run.')
    }
    return boundRow
  }
  if (runId !== undefined && row.run_id !== runId) {
    throw new OrchestrationError('conflict', 'The Maestro document is bound to a different run.')
  }
  return row
}
