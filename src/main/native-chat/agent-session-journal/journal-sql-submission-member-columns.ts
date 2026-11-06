import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalSqlValueLocation, StoredJournalSqlValue } from './journal-sql-value-codec'
import { journalSqlSubmissionMemberTable } from './journal-sql-submission-member-tables'

export function writeJournalSqlSubmissionMemberColumns(
  scope: JournalSqlScope,
  location: JournalSqlValueLocation,
  value: unknown,
  json: string
): boolean {
  const table = journalSqlSubmissionMemberTable(location.collection)
  if (!table) {
    return false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each named membership holds an admitted or retained submission.
  const send = value as AgentJournalSubmission
  const encoded: StoredJournalSqlValue = JSON.parse(json)
  const source = encoded.refs.find(
    (ref) =>
      ref.path.length === 0 &&
      ref.source.collection === 'submissions' &&
      ref.source.path.length === 0
  )?.source
  scope.db
    .prepare(`UPDATE ${table} SET submission_id=?, submission_incarnation=?, fence=?, submitted_seq=?
      WHERE session_id=? AND epoch=? AND input_id=? AND incarnation=?`)
    .run(
      source ? String(JSON.parse(source.key)) : send.clientMessageId,
      source?.incarnation ?? null,
      send.fence,
      send.submittedSequence ?? null,
      ...scope.prefix,
      String(JSON.parse(location.key)),
      location.incarnation
    )
  return true
}
