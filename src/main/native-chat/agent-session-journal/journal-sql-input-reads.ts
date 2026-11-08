import { journalInputOrder } from './input-order/journal-input-order'
import {
  answerJournalInput,
  type JournalInputRead,
  type JournalInputReadResult
} from './journal-input-reads'
import { JournalSqlReducer } from './journal-sql-reducer'
import type { JournalSqlScope } from './journal-sql-scope'
import { journalSqlOrderedKeys } from './journal-sql-keyed-values'

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
    () =>
      Array.from(journalSqlOrderedKeys(reducer.context, 'observations.inputIds'), (key) => {
        const value: unknown = JSON.parse(key)
        if (typeof value !== 'string') {
          throw new Error('Invalid journal input key')
        }
        return value
      }),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: untracking returns the decoded value the storage proxy wraps, of the same type.
    (value) => reducer.context.untracked('', value) as typeof value
  )
}
