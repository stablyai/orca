import { journalInputOrder } from './input-order/journal-input-order'
import {
  answerJournalInput,
  type JournalInputRead,
  type JournalInputReadResult
} from './journal-input-reads'
import { JournalSqlReducer } from './journal-sql-reducer'
import type { JournalSqlScope } from './journal-sql-scope'

/**
 * A reducer shell over the caller's read snapshot selects each population through the same typed
 * fact storage the writer keeps current; it is discarded with the answer and never flushed.
 */
export function readJournalSqlInput(
  scope: JournalSqlScope,
  operation: JournalInputRead
): JournalInputReadResult {
  const reducer = new JournalSqlReducer(scope, scope.epoch)
  return answerJournalInput(
    journalInputOrder(reducer.state),
    operation,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: untracking returns the decoded value the storage proxy wraps, of the same type.
    (value) => reducer.context.untracked('', value) as typeof value
  )
}
