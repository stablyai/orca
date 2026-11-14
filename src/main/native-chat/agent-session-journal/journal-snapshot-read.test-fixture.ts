import type { AgentJournalSnapshot } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { messageFixture, target } from './journal-sql-message.test-fixture'
import { JournalSqlScope } from './journal-sql-scope'

export function withJournalSnapshotRead<T>(
  snapshot: AgentJournalSnapshot,
  read: (scope: JournalSqlScope) => T
): T {
  const f = messageFixture()
  try {
    for (const item of snapshot.items) {
      f.seedItem(item)
    }
    for (const [ordinal, send] of snapshot.submissions.entries()) {
      f.db
        .prepare(`INSERT INTO journal_submission_attempts
        (session_id,epoch,message_id,attempt_sequence,attempt_index,current,item_id,ordinal,
          submitted_at,fingerprint,dispatch_state,payload_json)
        VALUES(?,?,?,0,0,1,?,?,?,?,?,?)`)
        .run(
          target.sessionId,
          target.epoch,
          send.clientMessageId,
          agentJournalSubmissionKey(send.clientMessageId),
          ordinal,
          send.submittedAt,
          send.payloadFingerprint,
          send.dispatchState,
          JSON.stringify(send)
        )
    }
    return read(new JournalSqlScope(f.db, target.sessionId, target.epoch))
  } finally {
    f.db.close()
  }
}
