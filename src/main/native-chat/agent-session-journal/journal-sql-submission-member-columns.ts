import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalSqlValueLocation, JournalSqlValueReference } from './journal-sql-value-codec'
import { journalSqlSubmissionMemberTable } from './journal-sql-submission-member-tables'

export function writeJournalSqlSubmissionMemberColumns(
  scope: JournalSqlScope,
  location: JournalSqlValueLocation,
  value: unknown,
  refs: readonly JournalSqlValueReference[]
): boolean {
  const table = journalSqlSubmissionMemberTable(location.collection)
  if (!table) {
    return false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each named membership holds an admitted or retained submission.
  const send = value as AgentJournalSubmission
  const captured = refs.length > 0
  scope.db
    .prepare(`UPDATE ${table} SET ${captured ? '' : 'submission_id=?, '}fence=?, submitted_seq=?
      WHERE session_id=? AND epoch=? AND input_id=? AND incarnation=?`)
    .run(
      ...(captured ? [] : [send.clientMessageId]),
      send.fence,
      send.submittedSequence ?? null,
      ...scope.prefix,
      String(JSON.parse(location.key)),
      location.incarnation
    )
  return true
}
