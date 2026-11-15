import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalDomainSubmissionStoredFacts } from './journal-domain-submission-records'
import { journalDomainSubmission } from './journal-domain-status-inputs'

const PAGE = 128

/** Coverage is current carrier evidence; ignoring one carrier exposes only its uniquely covered sends. */
export function journalDomainStoppedHistoryInputs(
  scope: JournalSqlScope,
  excluding: string,
  afterSequence = 0
) {
  const candidates: string[] = []
  let after: [number, string] = [-1, '']
  for (;;) {
    const rows = scope.db
      .prepare(`SELECT message_id,ordinal FROM journal_submission_attempts
      WHERE session_id=? AND epoch=? AND current=1 AND stopped_history=1 AND accepted_sequence>?
      AND (ordinal,message_id)>(?,?) ORDER BY ordinal,message_id LIMIT ?`)
      .all(...scope.prefix, afterSequence, ...after, PAGE)
    for (const row of rows) {
      scope.examined(row)
      candidates.push(String(row.message_id))
    }
    const last = rows.at(-1)
    if (rows.length < PAGE || !last) {
      break
    }
    after = [Number(last.ordinal), String(last.message_id)]
  }
  if (!candidates.length) {
    return []
  }
  const covered = new Set<string>()
  after = [-1, '']
  for (;;) {
    const rows = scope.db
      .prepare(`SELECT message_id,ordinal FROM journal_submission_attempts
      WHERE session_id=? AND epoch=? AND current=1 AND covers_stopped_history=1
      AND message_id<>? AND (ordinal,message_id)>(?,?) ORDER BY ordinal,message_id LIMIT ?`)
      .all(...scope.prefix, excluding, ...after, PAGE)
    for (const row of rows) {
      scope.examined(row)
      const facts = scope.db
        .prepare(`SELECT facts_json FROM journal_submission_attempts
        WHERE session_id=? AND epoch=? AND message_id=? AND current=1`)
        .get(...scope.prefix, String(row.message_id))!
      for (const id of scope.decode<JournalDomainSubmissionStoredFacts>(
        scope.examined(facts).facts_json
      ).carries) {
        covered.add(id)
      }
    }
    const last = rows.at(-1)
    if (rows.length < PAGE || !last) {
      break
    }
    after = [Number(last.ordinal), String(last.message_id)]
  }
  return candidates
    .filter((id) => !covered.has(id))
    .flatMap((id) => {
      const input = journalDomainSubmission(scope, id)
      return input ? [input] : []
    })
}
