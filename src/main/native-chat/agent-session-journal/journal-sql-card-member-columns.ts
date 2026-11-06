import type { JournalIndexedInputCard } from './journal-input-domain-index'
import type { QueuedMessageRow } from './queued-message-table'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalSqlValueLocation, StoredJournalSqlValue } from './journal-sql-value-codec'

const TABLES = {
  'cards.current': 'journal_proj_current_cards',
  'cards.overlays': 'journal_proj_overlay_cards',
  'cards.indexed': 'journal_proj_indexed_cards'
} as const

export function writeJournalSqlCardMemberColumns(
  scope: JournalSqlScope,
  location: JournalSqlValueLocation,
  value: unknown,
  json: string
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
  const encoded: StoredJournalSqlValue = JSON.parse(json)
  const cardRef = encoded.refs.find(
    (ref) =>
      (indexed ? ref.path.length === 1 && ref.path[0] === 'card' : ref.path.length === 0) &&
      ref.source.collection === 'queue.cards' &&
      ref.source.path.length === 0
  )?.source
  const key = [...scope.prefix, String(JSON.parse(location.key)), location.incarnation]
  scope.db
    .prepare(`UPDATE ${table} SET card_id=?, card_incarnation=?, position=?, state=?
      WHERE session_id=? AND epoch=? AND message_id=? AND incarnation=?`)
    .run(
      cardRef ? String(JSON.parse(cardRef.key)) : card.messageId,
      cardRef?.incarnation ?? null,
      card.position,
      card.state,
      ...key
    )
  if (indexed) {
    const lineage = encoded.refs.find(
      (ref) =>
        ref.path.length === 1 &&
        ref.path[0] === 'source' &&
        ref.source.collection === 'inputCards' &&
        ref.source.path.length === 0
    )?.source
    scope.db
      .prepare(`UPDATE journal_proj_indexed_cards SET lineage_message_id=?, lineage_incarnation=?,
        actionable=?, handoff=?, released=?, released_at=?
        WHERE session_id=? AND epoch=? AND message_id=? AND incarnation=?`)
      .run(
        lineage ? String(JSON.parse(lineage.key)) : null,
        lineage?.incarnation ?? null,
        Number(indexed.actionable),
        Number(indexed.handoff),
        Number(indexed.released),
        indexed.releasedAt ?? null,
        ...key
      )
  }
  return true
}
