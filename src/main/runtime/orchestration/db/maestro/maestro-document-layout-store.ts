import {
  MAX_MAESTRO_DELTAS,
  MAX_MAESTRO_DOCUMENT_BYTES,
  type MaestroActor,
  type MaestroDocumentLayoutMutation,
  type MaestroWorkspaceAnchor
} from '../../../../../shared/maestro-contract'
import type { OrchestrationDb } from '../orchestration-db'
import { OrchestrationError } from '../../orchestration-error'
import { ensureDocument, hashPayload, parseStoredDocument } from './maestro-document-store-core'
import type { MaestroMutationResult } from './maestro-document-store-core'

export function applyMaestroDocumentLayoutMutation(
  this: OrchestrationDb,
  mutation: MaestroDocumentLayoutMutation,
  _principal: MaestroActor
): MaestroMutationResult {
  const payloadHash = hashPayload(mutation)
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const receipt = this.db
      .prepare(
        `SELECT payload_hash, receipt_json FROM maestro_mutation_receipts
         WHERE execution_host_id = ? AND workspace_key = ? AND mutation_id = ?`
      )
      .get(mutation.scope.execution_host_id, mutation.scope.workspace_key, mutation.mutation_id) as
      | { payload_hash: string; receipt_json: string }
      | undefined
    if (receipt) {
      if (receipt.payload_hash !== payloadHash) {
        throw new OrchestrationError(
          'request_mismatch',
          'Mutation ID was reused with different input.'
        )
      }
      this.db.exec('COMMIT')
      return JSON.parse(receipt.receipt_json) as MaestroMutationResult
    }
    const row = ensureDocument.call(this, mutation.scope)
    if (row.revision !== mutation.expected_revision) {
      const conflict: MaestroMutationResult = {
        outcome: 'conflict',
        revision: row.revision,
        resetRequired: true
      }
      this.db
        .prepare(
          `INSERT INTO maestro_mutation_receipts (execution_host_id, workspace_key, mutation_id, payload_hash, receipt_json)
         VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          mutation.scope.execution_host_id,
          mutation.scope.workspace_key,
          mutation.mutation_id,
          payloadHash,
          JSON.stringify(conflict)
        )
      this.db.exec('COMMIT')
      return conflict
    }
    const document = parseStoredDocument(row.document_json)
    const affectedIds: string[] = []
    if (mutation.operation.kind === 'move-node') {
      const node = document.nodes[mutation.operation.node_id] ?? {}
      document.nodes[mutation.operation.node_id] = {
        ...node,
        position: mutation.operation.position
      }
      affectedIds.push(mutation.operation.node_id)
    } else {
      document.viewport = mutation.operation.viewport
    }
    const documentJson = JSON.stringify(document)
    if (Buffer.byteLength(documentJson, 'utf8') > MAX_MAESTRO_DOCUMENT_BYTES) {
      throw new OrchestrationError(
        'capacity_exceeded',
        'Maestro document exceeds its bounded capacity.'
      )
    }
    const revision = row.revision + 1
    const result: MaestroMutationResult = { outcome: 'applied', revision, affectedIds }
    this.db
      .prepare(
        `UPDATE maestro_documents SET revision = ?, document_json = ?, updated_at = datetime('now')
       WHERE execution_host_id = ? AND workspace_key = ?`
      )
      .run(revision, documentJson, mutation.scope.execution_host_id, mutation.scope.workspace_key)
    this.db
      .prepare(
        `INSERT INTO maestro_deltas (execution_host_id, workspace_key, revision, delta_json) VALUES (?, ?, ?, ?)`
      )
      .run(
        mutation.scope.execution_host_id,
        mutation.scope.workspace_key,
        revision,
        JSON.stringify(result)
      )
    this.db
      .prepare(
        `DELETE FROM maestro_deltas WHERE execution_host_id = ? AND workspace_key = ?
       AND revision <= ?`
      )
      .run(
        mutation.scope.execution_host_id,
        mutation.scope.workspace_key,
        revision - MAX_MAESTRO_DELTAS
      )
    this.db
      .prepare(
        `INSERT INTO maestro_mutation_receipts (execution_host_id, workspace_key, mutation_id, payload_hash, receipt_json)
       VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        mutation.scope.execution_host_id,
        mutation.scope.workspace_key,
        mutation.mutation_id,
        payloadHash,
        JSON.stringify(result)
      )
    this.db.exec('COMMIT')
    return result
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}
export function getMaestroDeltas(
  this: OrchestrationDb,
  workspace: MaestroWorkspaceAnchor,
  sinceRevision: number
):
  | { resetRequired: true; revision: number }
  | { resetRequired: false; revision: number; deltas: MaestroMutationResult[] } {
  const row = ensureDocument.call(this, workspace, workspace.run_id)
  const oldest = this.db
    .prepare(
      'SELECT MIN(revision) AS revision FROM maestro_deltas WHERE execution_host_id = ? AND workspace_key = ?'
    )
    .get(workspace.execution_host_id, workspace.workspace_key) as { revision: number | null }
  if (oldest.revision !== null && sinceRevision < oldest.revision - 1) {
    return { resetRequired: true, revision: row.revision }
  }
  const deltas = this.db
    .prepare(
      'SELECT delta_json FROM maestro_deltas WHERE execution_host_id = ? AND workspace_key = ? AND revision > ? ORDER BY revision'
    )
    .all(workspace.execution_host_id, workspace.workspace_key, sinceRevision) as {
    delta_json: string
  }[]
  return {
    resetRequired: false,
    revision: row.revision,
    deltas: deltas.map((delta) => JSON.parse(delta.delta_json) as MaestroMutationResult)
  }
}
