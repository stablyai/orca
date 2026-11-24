import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { boundedStoredJson, boundedStoredJsonSql } from './journal-stored-json-bounds'
import { readJournalStoredItem } from './journal-stored-output-rows'
import type Database from '../../sqlite/sync-database'
import { JOURNAL_HISTORY_ITEMS_LIMIT, type JournalHistoryItemSource } from './journal-history-items'

/** Only item IDs cross the deterministic prompt lookup; historical bodies stay in SQLite. */
export function* journalDomainUserItemIds(
  db: Database.Database,
  prefix: readonly [string, string]
): Iterable<string> {
  for (const row of db
    .prepare(`SELECT item_id FROM journal_items INDEXED BY journal_items_user_message
    WHERE session_id=? AND epoch=? AND hidden=0 AND kind='message' AND message_role='user'
    ORDER BY ordinal`)
    .iterate(...prefix)) {
    yield String(row.item_id)
  }
}

/** Turns a user item opened, directly or through a provider alias, in admission order. */
function journalDomainHistoryOpeners(
  db: Database.Database,
  prefix: readonly [string, string],
  itemId: string
): string[] {
  const rows = db
    .prepare(`SELECT item_id FROM journal_items
    WHERE session_id=?1 AND epoch=?2 AND hidden=0 AND opener_item_id IN (
      SELECT ?3 UNION SELECT provider_item_id FROM journal_item_aliases
      WHERE session_id=?1 AND epoch=?2 AND item_id=?3)
    ORDER BY ordinal LIMIT ?4`)
    .all(...prefix, itemId, JOURNAL_HISTORY_ITEMS_LIMIT + 1)
  if (rows.length > JOURNAL_HISTORY_ITEMS_LIMIT) {
    throw new Error('history-workspace-too-large')
  }
  return rows.map((row) => String(row.item_id))
}

type Prefix = readonly [string, string]

export function journalHistoryItemSource(
  db: Database.Database,
  prefix: Prefix,
  includeOpeners?: boolean
): JournalHistoryItemSource {
  const canonical = journalCanonicalItemId(db, prefix)
  const removed = db.prepare(`SELECT
    EXISTS(SELECT 1 FROM journal_item_tombstones WHERE session_id=?1 AND epoch=?2 AND item_id=?3)
    OR EXISTS(SELECT 1 FROM journal_items WHERE session_id=?1 AND epoch=?2 AND item_id=?3 AND hidden=1)
    AS removed`)
  return {
    canonicalItemId: canonical,
    item: (itemId) => journalVisibleItem(db, prefix, itemId),
    presentationRemoved: (key) => Boolean(removed.get(...prefix, canonical(key))!.removed),
    ...(includeOpeners
      ? { turnsOpenedBy: (itemId: string) => journalDomainHistoryOpeners(db, prefix, itemId) }
      : {})
  }
}

/** An item's journal id: a provider echo's (a Claude turn's opener) reads as the row it aliases. */
export function journalCanonicalItemId(db: Database.Database, prefix: Prefix) {
  const alias = db.prepare(`SELECT item_id FROM journal_item_aliases
    WHERE session_id=? AND epoch=? AND provider_item_id=?`)
  return (key: string): string => {
    const row = alias.get(...prefix, key)
    return row ? String(row.item_id) : key
  }
}

export function journalVisibleItem(
  db: Database.Database,
  prefix: Prefix,
  itemId: string
): AgentJournalRenderItem | null {
  const row = db
    .prepare(`SELECT ${boundedStoredJsonSql('payload_json', 'payload_json')} FROM journal_items
    WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0`)
    .get(...prefix, itemId)
  return row ? readJournalStoredItem(db, prefix, boundedStoredJson(row, 'payload_json')) : null
}
