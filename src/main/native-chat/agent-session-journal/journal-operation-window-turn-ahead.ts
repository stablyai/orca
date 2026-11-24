// The turn ahead a window takes on: the root turn before its earliest anchor and that turn's prompt.
import type { JournalSqlScope } from './journal-sql-scope'
import { INDEXED_ONLY_ROW_CAP } from './journal-operation-window-rows'
import { JournalWindowNotIndexed } from './journal-operation-window-sends'

/** The prompt ahead of the root turn before `sequence`: a held turn's predecessor and its opener. */
export function marginBefore(
  scope: JournalSqlScope,
  sequence: number,
  indexedOnly = false
): number {
  const turn = newestBefore(
    scope,
    'journal_items_status_turn',
    'turn_id IS NOT NULL',
    'root=1',
    sequence,
    indexedOnly
  )
  if (turn === null) {
    return 0
  }
  const user = newestBefore(
    scope,
    'journal_items_root_position',
    'root=1',
    "kind='message' AND message_role='user'",
    turn,
    indexedOnly
  )
  return user ?? 0
}

/** The newest row before `sequence` the index's own filter and `test` both hold for. `test` is no
 *  index column, so an indexed-only read looks back only as far as an admitted window could reach. */
function newestBefore(
  scope: JournalSqlScope,
  index: string,
  indexed: string,
  test: string,
  sequence: number,
  indexedOnly: boolean
): number | null {
  const where = `session_id=? AND epoch=? AND hidden=0 AND ${indexed} AND sequence<?`
  const found = indexedOnly
    ? scope.db
        .prepare(`SELECT MAX(CASE WHEN ${test} THEN sequence END) AS sequence, COUNT(*) AS rows
        FROM (SELECT sequence, root, kind, message_role FROM journal_items INDEXED BY ${index} WHERE ${where}
          ORDER BY sequence DESC LIMIT ?)`)
        .get(...scope.prefix, sequence, INDEXED_ONLY_ROW_CAP + 1)
    : scope.db
        .prepare(`SELECT MAX(sequence) AS sequence FROM journal_items INDEXED BY ${index}
        WHERE ${where} AND ${test}`)
        .get(...scope.prefix, sequence)
  const at = found?.sequence
  if (at === null || at === undefined) {
    if (indexedOnly && Number(found?.rows) > INDEXED_ONLY_ROW_CAP) {
      throw new JournalWindowNotIndexed()
    }
    return null
  }
  return Number(at)
}
