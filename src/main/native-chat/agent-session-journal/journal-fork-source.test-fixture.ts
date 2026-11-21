import type Database from '../../sqlite/sync-database'
import type { AgentJournalSnapshot } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { encodeAgentSessionRecord } from '../../../shared/agent-session/lifecycle/records/agent-session-record-stored-form'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { insertJournalDomainItemRows } from './journal-domain-import-rows'

/** Test setup writes a saved source before the production reader/writer protocol consumes it. */
export function seedJournalForkSource(
  db: Database.Database,
  snapshot: AgentJournalSnapshot,
  record: AgentSessionRecord
): void {
  const epoch = snapshot.cursor.epoch
  const sessionId = record.sessionId
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      'INSERT INTO agent_session_records(session_id,record_json) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET record_json=excluded.record_json'
    ).run(sessionId, JSON.stringify(encodeAgentSessionRecord(record)))
    db.prepare(`INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence)
      VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET epoch=excluded.epoch,last_sequence=excluded.last_sequence,highest_fence=excluded.highest_fence`).run(
      record.location.workspaceId,
      sessionId,
      epoch,
      snapshot.cursor.sequence,
      record.lease.runtimeFence
    )
    for (const table of [
      'journal_items',
      'journal_submission_attempts',
      'journal_item_subagent_names'
    ]) {
      db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(sessionId)
    }
    insertJournalDomainItemRows(
      db,
      { sessionId, epoch },
      snapshot.items.map((item, ordinal) => ({
        item,
        ordinal: ordinal + 1,
        ownerFence: 0,
        executionOwner: null,
        hidden: false,
        turnItemId: item.turnScope?.kind === 'turn' ? item.turnScope.turnItemId : null,
        originalStopNoteJson: null,
        queueCommandTurn: false,
        queueFailedOutcome: false,
        queueFailedAt: 0,
        queueFailureWitnessedThrough: 0,
        queueFailureReportTurnItemId: null
      }))
    )
    for (const [ordinal, send] of snapshot.submissions.entries()) {
      db.prepare(`INSERT INTO journal_submission_attempts
        (session_id,epoch,message_id,attempt_sequence,attempt_index,current,item_id,ordinal,
          submitted_at,fingerprint,dispatch_state,accepted_sequence,payload_json)
        VALUES(?,?,?,0,0,1,?,?,?,?,?,?,?)`).run(
        sessionId,
        epoch,
        send.clientMessageId,
        agentJournalSubmissionKey(send.clientMessageId),
        ordinal,
        send.submittedAt,
        send.payloadFingerprint,
        send.dispatchState,
        send.acceptedSequence ?? null,
        JSON.stringify(send)
      )
    }
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) {
      db.exec('ROLLBACK')
    }
    throw error
  }
}
