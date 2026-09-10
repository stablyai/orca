import type {
  MaestroDocumentReadResult,
  MaestroDocumentReadScope,
  MaestroMutation
} from '../../../../../shared/maestro-contract'
import {
  MAX_MAESTRO_DELTAS,
  MAX_MAESTRO_DOCUMENT_BYTES
} from '../../../../../shared/maestro-contract'
import type { MaestroPrincipal } from '../../../../../shared/maestro-actor'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import {
  type MaestroContextSnapshotStoreMethods,
  attachMaestroContextSnapshotStore,
  deriveMaestroContextSnapshot,
  pinMaestroContextSnapshot
} from './maestro-context-snapshot-store'
import { type MaestroIntentStoreMethods, attachMaestroIntentStore } from './maestro-intent-store'
import { applyMaestroDocumentAuthoringMutation } from './maestro-document-authoring-store'
import {
  applyMaestroDocumentLayoutMutation,
  getMaestroDeltas
} from './maestro-document-layout-store'
import {
  ensureDocument,
  hashPayload,
  parseStoredDocument,
  documentRow,
  type MaestroMutationResult
} from './maestro-document-store-core'

export function getMaestroDocument(
  this: OrchestrationDb,
  scope: MaestroDocumentReadScope
): MaestroDocumentReadResult {
  const row = documentRow.call(this, scope)
  if (!row) {
    return { state: 'empty', revision: null, document: null, updatedAt: null }
  }
  return {
    state: 'ready',
    revision: row.revision,
    document: parseStoredDocument(row.document_json),
    updatedAt: row.updated_at
  }
}

export function applyMaestroMutation(
  this: OrchestrationDb,
  mutation: MaestroMutation,
  principal: MaestroPrincipal
): MaestroMutationResult {
  const payloadHash = hashPayload(mutation)
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const receipt = this.db
      .prepare(
        `SELECT payload_hash, receipt_json FROM maestro_mutation_receipts
         WHERE execution_host_id = ? AND workspace_key = ? AND mutation_id = ?`
      )
      .get(
        mutation.workspace.execution_host_id,
        mutation.workspace.workspace_key,
        mutation.mutation_id
      ) as { payload_hash: string; receipt_json: string } | undefined
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
    const row = ensureDocument.call(this, mutation.workspace, mutation.workspace.run_id)
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
          mutation.workspace.execution_host_id,
          mutation.workspace.workspace_key,
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
      const requestedSnapshot = mutation.operation.snapshot
      const note = document.nodes[requestedSnapshot.note_id]
      const noteRevision = Number(requestedSnapshot.revision.replace(/^note-/, ''))
      if (
        !row.run_id ||
        note?.kind !== 'note' ||
        !Number.isInteger(noteRevision) ||
        note.note_revision !== noteRevision
      ) {
        throw new OrchestrationError(
          'conflict',
          'The pinned note revision is stale or not a note endpoint.'
        )
      }
      const authoritativeSnapshot = deriveMaestroContextSnapshot({
        scope: mutation.workspace,
        nodeId: requestedSnapshot.note_id,
        noteRevision,
        title: note.title ?? requestedSnapshot.note_id,
        content: note.markdown ?? '',
        ownerPrincipal: principal.actor_id
      })
      if (JSON.stringify(authoritativeSnapshot) !== JSON.stringify(requestedSnapshot)) {
        throw new OrchestrationError(
          'request_mismatch',
          'The pinned snapshot metadata is not authoritative.'
        )
      }
      const snapshotId = pinMaestroContextSnapshot.call(this, {
        scope: mutation.workspace,
        nodeId: requestedSnapshot.note_id,
        noteRevision,
        title: note.title ?? requestedSnapshot.note_id,
        content: note.markdown ?? '',
        ownerPrincipal: principal.actor_id
      })
      affectedIds.push(snapshotId)
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
      .run(
        revision,
        documentJson,
        mutation.workspace.execution_host_id,
        mutation.workspace.workspace_key
      )
    this.db
      .prepare(
        `INSERT INTO maestro_deltas (execution_host_id, workspace_key, revision, delta_json) VALUES (?, ?, ?, ?)`
      )
      .run(
        mutation.workspace.execution_host_id,
        mutation.workspace.workspace_key,
        revision,
        JSON.stringify(result)
      )
    this.db
      .prepare(
        `DELETE FROM maestro_deltas WHERE execution_host_id = ? AND workspace_key = ?
       AND revision <= ?`
      )
      .run(
        mutation.workspace.execution_host_id,
        mutation.workspace.workspace_key,
        revision - MAX_MAESTRO_DELTAS
      )
    this.db
      .prepare(
        `INSERT INTO maestro_mutation_receipts (execution_host_id, workspace_key, mutation_id, payload_hash, receipt_json)
       VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        mutation.workspace.execution_host_id,
        mutation.workspace.workspace_key,
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

export type MaestroStoreMethods = MaestroIntentStoreMethods &
  MaestroContextSnapshotStoreMethods & {
    getMaestroDocument: typeof getMaestroDocument
    applyMaestroMutation: typeof applyMaestroMutation
    applyMaestroDocumentLayoutMutation: typeof applyMaestroDocumentLayoutMutation
    applyMaestroDocumentAuthoringMutation: typeof applyMaestroDocumentAuthoringMutation
    getMaestroDeltas: typeof getMaestroDeltas
  }

export function attachMaestroStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getMaestroDocument,
    applyMaestroMutation,
    applyMaestroDocumentLayoutMutation,
    applyMaestroDocumentAuthoringMutation,
    getMaestroDeltas
  })
  attachMaestroContextSnapshotStore(ctor)
  attachMaestroIntentStore(ctor)
}
