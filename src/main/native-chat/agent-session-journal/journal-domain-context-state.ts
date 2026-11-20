import type Database from '../../sqlite/sync-database'
import type { JournalHistoryOrigin } from './context-epochs/journal-history-origin'
import type { JournalReplacementItem } from './context-epochs/journal-epoch-replacement'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentJournalLinkageFields } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { readJournalStoredItem } from './journal-stored-output-rows'

type Target = { sessionId: string; epoch: string }

export function readJournalDomainContextHead(db: Database.Database, target: Target) {
  const head = db
    .prepare(`SELECT last_sequence, highest_fence, context_boundary, queue_clear_operation_id,
      queue_failure_boundary, history_origin_json FROM journal_chat_state WHERE session_id=? AND epoch=? AND epoch IS NOT NULL`)
    .get(target.sessionId, target.epoch)
  if (!head) {
    throw new Error('journal context command targets a retired chat epoch')
  }
  const historyOrigin: JournalHistoryOrigin | null =
    head.history_origin_json === null ? null : JSON.parse(String(head.history_origin_json))
  return {
    lastSequence: Number(head.last_sequence),
    highestFence: Number(head.highest_fence),
    contextBoundary: Number(head.context_boundary),
    cleared: head.queue_clear_operation_id !== null,
    failureBoundary: Number(head.queue_failure_boundary),
    historyOrigin
  }
}

export function readRetainedJournalContextItems(
  db: Database.Database,
  target: Target
): JournalReplacementItem[] {
  const prefix = [target.sessionId, target.epoch] as const
  return db
    .prepare(`SELECT payload_json, output_blob, owner_fence, execution_owner FROM journal_items
    WHERE session_id=? AND epoch=? ORDER BY sequence, sequence_index, ordinal`)
    .all(...prefix)
    .map((row) => {
      const item = readJournalStoredItem(db, prefix, row.payload_json, row.output_blob)
      const identity = parseAgentJournalItemKey(item.itemId)
      if (!identity) {
        throw new Error('journal history retention found an invalid item identity')
      }
      return {
        identity,
        body: item.body,
        observedAt: item.observedAt,
        turnScope: item.turnScope,
        ...agentJournalLinkageFields(item),
        ownerFence: Number(row.owner_fence),
        ...(row.execution_owner === null ? {} : { executionOwner: Number(row.execution_owner) })
      }
    })
}
