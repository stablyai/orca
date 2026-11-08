import type Database from '../../sqlite/sync-database'
import type { JournalWriterCommit } from './journal-writer-changes'

type Target = { sessionId: string; epoch: string }

export async function trackJournalDomainQueueRevision(
  db: Database.Database,
  sessionId: string,
  execute: () => Promise<JournalWriterCommit>
): Promise<JournalWriterCommit> {
  if (!db.isTransaction) {
    throw new Error('journal SQL command requires its transaction')
  }
  const before = readJournalDomainQueueRevision(db, sessionId)
  const commit = await execute()
  let after = readJournalDomainQueueRevision(db, sessionId)
  if (before.epoch === after.epoch && before.dependencies !== after.dependencies) {
    invalidateJournalDomainQueue(db, { sessionId, epoch: after.epoch }, after.sequence)
    after = readJournalDomainQueueRevision(db, sessionId)
  }
  commit.inputChanged ||= before.epoch !== after.epoch || before.revision !== after.revision
  commit.queueRevision = `${after.epoch}:${after.revision}`
  return commit
}

/** Several dependency changes in one source unit share its next event position. */
export function invalidateJournalDomainQueue(
  db: Database.Database,
  target: Target,
  sequence?: number
): void {
  db.prepare(`UPDATE journal_chat_state SET queue_revision=MAX(queue_revision,COALESCE(?,last_sequence+1))
    WHERE session_id=? AND epoch=?`).run(sequence ?? null, target.sessionId, target.epoch)
}

/** Only scalar facts used by queue pauses/eligibility; ordinary text revisions have no signature. */
export function journalDomainQueueItemDependency(
  db: Database.Database,
  target: Target,
  itemId: string
): string {
  return JSON.stringify(
    db
      .prepare(`SELECT hidden,root,sequence,sequence_index,owner_fence,execution_owner,
        turn_marker,turn_id,opener_item_id,turn_item_id,turn_scope_kind,lifecycle_state,
        turn_completed_at,command_entry,queue_command_turn,queue_failed_outcome,queue_failed_at,
        queue_failure_witnessed_through,queue_failure_report_turn_item_id
      FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?
        AND (turn_marker=1 OR prompt=1 OR command_entry=1
          OR queue_failure_report_turn_item_id IS NOT NULL)`)
      .get(target.sessionId, target.epoch, itemId) ?? null
  )
}

export function readJournalDomainQueueRevision(db: Database.Database, sessionId: string) {
  const head = db
    .prepare(`SELECT epoch,last_sequence,queue_revision,context_boundary,accepted_handover_sequence,
      queue_latest_stop_json,queue_manual_stop_json,queue_resumed_sequence,queue_reopened_sequence,
      queue_clear_sequence,queue_clear_operation_id,queue_clear_lifted,queue_failure_boundary
    FROM journal_chat_state WHERE session_id=? AND epoch IS NOT NULL`)
    .get(sessionId)
  if (!head) {
    throw new Error('queue revision targets a retired chat')
  }
  const { epoch, last_sequence: sequence, queue_revision: revision, ...dependencies } = head
  return {
    epoch: String(epoch),
    sequence: Number(sequence),
    revision: Number(revision),
    dependencies: JSON.stringify(dependencies)
  }
}
