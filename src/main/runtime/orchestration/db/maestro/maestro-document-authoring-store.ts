import {
  MaestroDocumentSchema,
  MAX_MAESTRO_DELTAS,
  type MaestroDocumentAuthoringMutation
} from '../../../../../shared/maestro-contract'
import type { MaestroPrincipal } from '../../../../../shared/maestro-actor'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import {
  ensureDocument,
  hashDocumentState,
  hashPayload,
  parseStoredDocument,
  recordDocumentMutation,
  storedReceiptResult,
  authoringReceipt,
  type MaestroDocumentAuthoringMutationResult
} from './maestro-document-store-core'
import { pinMaestroContextSnapshot } from './maestro-context-snapshot-store'

export function applyMaestroDocumentAuthoringMutation(
  this: OrchestrationDb,
  mutation: MaestroDocumentAuthoringMutation,
  principal: MaestroPrincipal
): MaestroDocumentAuthoringMutationResult {
  if (
    mutation.scope.execution_host_id !== principal.workspace.execution_host_id ||
    mutation.scope.workspace_key !== principal.workspace.workspace_key ||
    mutation.scope.run_id !== principal.workspace.run_id
  ) {
    throw new OrchestrationError(
      'unauthorized',
      'Authoring mutations require the resolved current run.'
    )
  }
  const payloadHash = hashPayload(mutation)
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const row = ensureDocument.call(this, mutation.scope, mutation.scope.run_id, true)
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
          'Authoring mutation ID was reused with different input.'
        )
      }
      this.db.exec('COMMIT')
      return storedReceiptResult(receipt.receipt_json)
    }
    if (row.revision !== mutation.expected_revision) {
      const conflict: MaestroDocumentAuthoringMutationResult = {
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

    const before = parseStoredDocument(row.document_json)
    let after = before
    const affectedIds: string[] = []
    const operation = mutation.operation
    if (operation.kind === 'create-note') {
      if (before.nodes[operation.node_id]) {
        throw new OrchestrationError('request_mismatch', 'The Maestro note already exists.')
      }
      after = {
        ...before,
        nodes: {
          ...before.nodes,
          [operation.node_id]: {
            kind: 'note',
            position: operation.position,
            title: operation.title,
            markdown: operation.markdown,
            note_revision: 1
          }
        }
      }
      affectedIds.push(operation.node_id)
    }
    if (operation.kind === 'update-note') {
      const note = before.nodes[operation.node_id]
      if (note?.kind !== 'note' || note.note_revision !== operation.expected_note_revision) {
        throw new OrchestrationError('conflict', 'The Maestro note revision is stale.')
      }
      after = {
        ...before,
        nodes: {
          ...before.nodes,
          [operation.node_id]: {
            ...note,
            title: operation.title,
            markdown: operation.markdown,
            note_revision: note.note_revision + 1
          }
        }
      }
      affectedIds.push(operation.node_id)
    }
    if (operation.kind === 'create-edge') {
      if (!before.nodes[operation.source_id] || !before.nodes[operation.target_id]) {
        throw new OrchestrationError('request_mismatch', 'A Maestro link needs existing endpoints.')
      }
      let contextSnapshotId: string | undefined
      if (operation.type === 'context_for') {
        const contextNote = operation.context_note_id
          ? before.nodes[operation.context_note_id]
          : undefined
        if (
          !operation.context_note_id ||
          (operation.context_note_id !== operation.source_id &&
            operation.context_note_id !== operation.target_id) ||
          operation.expected_note_revision === undefined ||
          contextNote?.kind !== 'note' ||
          contextNote.note_revision !== operation.expected_note_revision
        ) {
          throw new OrchestrationError(
            'conflict',
            'Context links require the current note endpoint revision.'
          )
        }
        contextSnapshotId = pinMaestroContextSnapshot.call(this, {
          scope: {
            execution_host_id: mutation.scope.execution_host_id,
            workspace_key: mutation.scope.workspace_key,
            run_id: mutation.scope.run_id
          },
          nodeId: operation.context_note_id,
          noteRevision: contextNote.note_revision,
          title: contextNote.title ?? operation.context_note_id,
          content: contextNote.markdown ?? '',
          ownerPrincipal: principal.actor_id
        })
      }
      const edge = {
        id: operation.id,
        source_id: operation.source_id,
        target_id: operation.target_id,
        type: operation.type,
        direction: operation.direction,
        projected: false as const,
        ...(operation.type === 'context_for' && operation.context_note_id
          ? { context_note_id: operation.context_note_id }
          : {}),
        ...(contextSnapshotId ? { context_snapshot_id: contextSnapshotId } : {})
      }
      if (before.edges.some((candidate) => candidate.id === edge.id)) {
        throw new OrchestrationError('request_mismatch', 'The Maestro link already exists.')
      }
      after = { ...before, edges: [...before.edges, edge] }
      affectedIds.push(edge.id)
      if (contextSnapshotId) {
        affectedIds.push(contextSnapshotId)
      }
    }
    if (operation.kind === 'delete-edge') {
      const edge = before.edges.find((candidate) => candidate.id === operation.edge_id)
      if (!edge || edge.projected) {
        throw new OrchestrationError('request_mismatch', 'The Maestro link is not editable.')
      }
      after = {
        ...before,
        edges: before.edges.filter((candidate) => candidate.id !== operation.edge_id)
      }
      affectedIds.push(operation.edge_id)
    }
    if (operation.kind === 'undo' || operation.kind === 'redo') {
      const target = this.db
        .prepare(
          `SELECT receipt_json FROM maestro_mutation_receipts
         WHERE execution_host_id = ? AND workspace_key = ? AND mutation_id = ?`
        )
        .get(
          mutation.scope.execution_host_id,
          mutation.scope.workspace_key,
          operation.target_mutation_id
        ) as { receipt_json: string } | undefined
      const history = target ? authoringReceipt(target.receipt_json) : undefined
      if (!history) {
        throw new OrchestrationError(
          'history_unavailable',
          'The requested authoring history is unavailable.'
        )
      }
      const expected = operation.kind === 'undo' ? history.after : history.before
      const replacement = operation.kind === 'undo' ? history.before : history.after
      if (hashDocumentState(before) !== hashDocumentState(expected)) {
        throw new OrchestrationError(
          'conflict',
          'The document changed after the requested history entry.'
        )
      }
      const stack = before.authoring_history
      if (operation.kind === 'undo') {
        if (stack.undo_stack.at(-1) !== operation.target_mutation_id) {
          throw new OrchestrationError(
            'conflict',
            'Only the latest authoring mutation can be undone.'
          )
        }
        after = {
          ...replacement,
          authoring_history: {
            undo_stack: stack.undo_stack.slice(0, -1),
            redo_stack: [...stack.redo_stack, operation.target_mutation_id].slice(
              -MAX_MAESTRO_DELTAS
            )
          }
        }
      } else {
        if (stack.redo_stack.at(-1) !== operation.target_mutation_id) {
          throw new OrchestrationError('conflict', 'Only the latest undone mutation can be redone.')
        }
        after = {
          ...replacement,
          authoring_history: {
            undo_stack: [...stack.undo_stack, operation.target_mutation_id].slice(
              -MAX_MAESTRO_DELTAS
            ),
            redo_stack: stack.redo_stack.slice(0, -1)
          }
        }
      }
      affectedIds.push(operation.target_mutation_id)
    }
    if (operation.kind !== 'undo' && operation.kind !== 'redo') {
      after = {
        ...after,
        authoring_history: {
          undo_stack: [...before.authoring_history.undo_stack, mutation.mutation_id].slice(
            -MAX_MAESTRO_DELTAS
          ),
          redo_stack: []
        }
      }
    }
    const result = recordDocumentMutation(
      this,
      mutation.scope,
      mutation.mutation_id,
      payloadHash,
      before,
      MaestroDocumentSchema.parse(after),
      affectedIds
    )
    this.db.exec('COMMIT')
    return result
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}
