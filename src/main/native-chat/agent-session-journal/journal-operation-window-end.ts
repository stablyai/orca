// Where an operation window may stop: a reader of the anchored turns alone needs nothing after them.
import type { JournalSqlScope } from './journal-sql-scope'

/** Where the first root turn after `sequence` opens; null when none has, so the window runs to the
 *  head. A send steered into the anchored turn sits before it, so the turn keeps all of its rows. */
export function marginAfter(scope: JournalSqlScope, sequence: number): number | null {
  const turn = scope.db
    .prepare(`SELECT MIN(sequence) AS sequence FROM journal_items INDEXED BY journal_items_status_turn
    WHERE session_id=? AND epoch=? AND hidden=0 AND turn_id IS NOT NULL AND root=1 AND sequence>?`)
    .get(...scope.prefix, sequence)?.sequence
  return turn === null || turn === undefined ? null : Number(turn)
}
