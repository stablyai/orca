import type Database from '../../sqlite/sync-database'
import { JOURNAL_HISTORY_ITEMS_LIMIT } from './journal-history-items'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { boundedStoredJson, boundedStoredJsonSql } from './journal-stored-json-bounds'
import { readJournalStoredItem } from './journal-stored-output-rows'

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
export function journalDomainHistoryOpeners(
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

// A history observation compares outputs by size and digest, so a large one comes back cut.
const HISTORY_ITEM_SHORTEN_BYTES = 1024 * 1024

/** A visible item, with a tool output or patch over 1 MiB cut and the item marked shortened. */
export function journalDomainHistoryItem(
  db: Database.Database,
  prefix: readonly [string, string],
  itemId: string
): AgentJournalRenderItem | null {
  const row = db
    .prepare(
      `SELECT ${boundedStoredJsonSql('payload_json', 'payload_json', {
        bytes: 'octet_length(payload_json)',
        shortenColumn: 'payload_json',
        shortenFrom: HISTORY_ITEM_SHORTEN_BYTES
      })} FROM journal_items WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0`
    )
    .get(...prefix, itemId)
  if (!row) {
    return null
  }
  const json = String(boundedStoredJson(row, 'payload_json'))
  const item = readJournalStoredItem(db, prefix, json)
  const cut = Number(row.payload_json_bytes) > Buffer.byteLength(json, 'utf8')
  return cut ? { ...item, shortened: true } : item
}
