import type { JournalIndexedInputCard } from './journal-input-domain-index'
import type { QueuedMessageRow } from './queued-message-table'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalSqlValueLocation, JournalSqlValueReference } from './journal-sql-value-codec'

const TABLES = {
  'cards.current': 'journal_proj_current_cards',
  'cards.overlays': 'journal_proj_overlay_cards',
  'cards.indexed': 'journal_proj_indexed_cards'
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: indexed cards retain their card/source pair and flags; the other families retain a card.
  const indexed =
    location.collection === 'cards.indexed' ? (value as JournalIndexedInputCard) : undefined
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the other declared card families hold a QueuedMessageRow.
  const card = indexed ? indexed.card : (value as QueuedMessageRow)
  const captured = (path: string) => refs.some((ref) => ref.path.join('.') === path)
  const key = [...scope.prefix, String(JSON.parse(location.key)), location.incarnation]
  const cardCaptured = captured(indexed ? 'card' : '')
  scope.db
    .prepare(`UPDATE ${table} SET ${cardCaptured ? '' : 'card_id=?, '}position=?, state=?
      WHERE session_id=? AND epoch=? AND message_id=? AND incarnation=?`)
    .run(...(cardCaptured ? [] : [card.messageId]), card.position, card.state, ...key)
  if (indexed) {
    scope.db
      .prepare(`UPDATE journal_proj_indexed_cards SET ${captured('source') ? '' : 'lineage_message_id=NULL, '}
        actionable=?, handoff=?, released=?, released_at=?
        WHERE session_id=? AND epoch=? AND message_id=? AND incarnation=?`)
      .run(
        Number(indexed.actionable),
        Number(indexed.handoff),
        Number(indexed.released),
        indexed.releasedAt ?? null,
        ...key
      )
  }
  return true
}
