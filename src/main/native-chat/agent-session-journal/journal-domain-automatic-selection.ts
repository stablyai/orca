import { selectJournalEligibleQueueCard } from './journal-domain-input-eligibility'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalAutomaticSelection } from './journal-automatic-submission'
import type { JournalSqlQueueFacts } from './journal-sql-queued-messages'

/** Current work and ordered cards are decided at the same fixed edit-hold instant. */
export function selectJournalAutomaticSubmission(
  scope: JournalSqlScope,
  selection: JournalAutomaticSelection,
  now: number,
  facts: JournalSqlQueueFacts
) {
  return selectJournalEligibleQueueCard(scope, selection.authority, now, facts, true)
}
