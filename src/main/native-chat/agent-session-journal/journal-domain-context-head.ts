import type Database from '../../sqlite/sync-database'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalHistoryOrigin } from './context-epochs/journal-history-origin'
import { journalContextEpoch } from './context-epochs/journal-context-epoch'

type Target = { sessionId: string; epoch: string }

export function readJournalDomainContextHead(db: Database.Database, target: Target) {
  const head = db
    .prepare(`SELECT last_sequence, highest_fence, context_boundary, queue_clear_operation_id,
      queue_failure_boundary FROM journal_chat_state WHERE session_id=? AND epoch=? AND epoch IS NOT NULL`)
    .get(target.sessionId, target.epoch)
  if (!head) {
    throw new Error('journal context command targets a retired chat epoch')
  }
  return {
    lastSequence: Number(head.last_sequence),
    highestFence: Number(head.highest_fence),
    contextBoundary: Number(head.context_boundary),
    cleared: head.queue_clear_operation_id !== null,
    failureBoundary: Number(head.queue_failure_boundary)
  }
}

export function journalDomainPublicCursor(
  db: Database.Database,
  target: Target,
  sequence: number
): AgentJournalCursor {
  const head = db
    .prepare('SELECT context_boundary FROM journal_chat_state WHERE session_id=? AND epoch=?')
    .get(target.sessionId, target.epoch)
  if (!head) {
    throw new Error('journal context command targets a retired chat epoch')
  }
  return { epoch: journalContextEpoch(target.epoch, Number(head.context_boundary)), sequence }
}

export function readJournalDomainHistoryOrigin(
  db: Database.Database,
  target: Target
): JournalHistoryOrigin | null {
  const row = db
    .prepare('SELECT history_origin_json FROM journal_chat_state WHERE session_id=? AND epoch=?')
    .get(target.sessionId, target.epoch)
  return row?.history_origin_json == null ? null : JSON.parse(String(row.history_origin_json))
}
