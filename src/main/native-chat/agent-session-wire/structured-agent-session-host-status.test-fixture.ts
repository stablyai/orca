import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { withJournalSnapshotRead } from '../agent-session-journal/journal-snapshot-read.test-fixture'
import {
  JOURNAL_DOMAIN_SUBMISSION_COLUMNS,
  journalDomainSubmissionColumns
} from '../agent-session-journal/journal-domain-submission-columns'
import { JournalSqlStatusContext } from '../agent-session-journal/journal-sql-status-context'
import { readJournalSqlStatusState } from '../agent-session-journal/journal-sql-status-state'
import {
  withHostTurnEnd,
  type StructuredAgentSessionStatusState
} from './observations/structured-agent-session-status-journal-projection'

/** The host's status read of these rows: the SQL reader, then a bot host's quiet turn-end policy. */
export function readHostStatusState(
  items: AgentJournalRenderItem[],
  submissions: AgentJournalSubmission[] = [],
  quietEnd?: (outcome: 'success' | 'failure') => boolean
): StructuredAgentSessionStatusState {
  const state = withJournalSnapshotRead(
    { sessionId: 'chat', cursor: { epoch: 'epoch', sequence: 0 }, items, submissions },
    (scope) => {
      // The snapshot seeds only payloads; the reader selects sends by their saved columns.
      for (const send of submissions) {
        scope.db
          .prepare(
            `UPDATE journal_submission_attempts SET ${JOURNAL_DOMAIN_SUBMISSION_COLUMNS.map((column) => `${column}=?`).join(',')}
            WHERE session_id=? AND epoch=? AND message_id=?`
          )
          .run(...journalDomainSubmissionColumns(send, []), ...scope.prefix, send.clientMessageId)
      }
      return readJournalSqlStatusState(
        new JournalSqlStatusContext(scope),
        undefined,
        undefined,
        true
      )
    }
  )
  return withHostTurnEnd(state, quietEnd)
}
