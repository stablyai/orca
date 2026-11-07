import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalSqlValueLocation, JournalSqlValueReference } from './journal-sql-value-codec'

const TABLES = {
  'cards.current': 'journal_proj_current_cards',
  'cards.overlays': 'journal_proj_overlay_cards'
} as const

export function writeJournalSqlCardMemberColumns(
  scope: JournalSqlScope,
  location: JournalSqlValueLocation,
  value: unknown,
  refs: readonly JournalSqlValueReference[]
): boolean {
  if (!Object.hasOwn(TABLES, location.collection)) {
    return false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the declared card families select a table.
  const table = TABLES[location.collection as keyof typeof TABLES]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the declared card families hold a QueuedMessageRow.
  const card = value as QueuedMessageRow
  const key = [...scope.prefix, String(JSON.parse(location.key)), location.incarnation]
  const cardCaptured = refs.some((ref) => ref.path.join('.') === '')
  scope.db
    .prepare(`UPDATE ${table} SET ${cardCaptured ? '' : 'card_id=?, '}position=?, state=?
      WHERE session_id=? AND epoch=? AND message_id=? AND incarnation=?`)
    .run(...(cardCaptured ? [] : [card.messageId]), card.position, card.state, ...key)
  return true
}
