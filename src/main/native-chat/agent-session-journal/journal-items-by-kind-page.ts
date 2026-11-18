import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { measureJournalStoredRow } from './journal-stored-output-rows'
import { boundedStoredJson, boundedStoredJsonSql } from './journal-stored-json-bounds'

/**
 * A row-count page of tool output can reach hundreds of MB, which main decodes on its shared heap;
 * rows past this much JSON go to the next page, far below the reader reply limit. A lone larger
 * row still goes alone, so the visit always advances; one past the reply limit goes shortened.
 */
export const ITEMS_BY_KIND_PAGE_JSON_BUDGET = 8 * 2 ** 20

/** A row's decoded JSON length, and its item, decoded only once the row fits the page. */
export type ItemsByKindRowRead = { bytes: number; item: () => AgentJournalRenderItem }

function readInlineRow(row: Record<string, unknown>): ItemsByKindRowRead {
  const json = String(row.payload_json)
  return { bytes: json.length, item: () => JSON.parse(json) }
}

/** `rows` are the chosen items in ordinal order, read lazily so rows past the budget stay unread. */
export function budgetItemsByKindPage(
  rows: Iterable<Record<string, unknown>>,
  nextOrdinal: number | null,
  budget = ITEMS_BY_KIND_PAGE_JSON_BUDGET,
  read: (row: Record<string, unknown>) => ItemsByKindRowRead = readInlineRow
): { items: AgentJournalRenderItem[]; nextOrdinal: number | null } {
  const items: AgentJournalRenderItem[] = []
  let used = 0
  let lastKept = -1
  for (const row of rows) {
    const { bytes, item } = read(row)
    if (items.length > 0 && used + bytes > budget) {
      return { items, nextOrdinal: lastKept }
    }
    used += bytes
    lastKept = Number(row.ordinal)
    items.push(item())
  }
  return { items, nextOrdinal }
}

/** Payload by primary key, so a page cut by the budget looks up no further rows. */
export const ITEMS_BY_KIND_PAYLOAD_SQL = `SELECT ${boundedStoredJsonSql('payload_json', 'payload_json', { shortenColumn: 'payload_json' })},
  ordinal,output_blob FROM journal_items
  WHERE session_id=? AND epoch=? AND item_id=?`

/** Each chosen item's row, in order, read only as the page budget asks for it. */
export function* itemsByKindPayloads(
  chosen: readonly SqliteRow[],
  lookup: (itemId: SqliteRow[string]) => SqliteRow | undefined
): Generator<SqliteRow> {
  for (const header of chosen) {
    const row = lookup(header.item_id)
    if (row) {
      yield row
    }
  }
}

/** One budgeted page of the chosen items, stored outputs restored and counted at full size. */
export function readItemsByKindPage(
  db: Database.Database,
  prefix: readonly [sessionId: string, epoch: string],
  chosen: readonly SqliteRow[],
  nextOrdinal: number | null
): { items: AgentJournalRenderItem[]; nextOrdinal: number | null } {
  const payload = db.prepare(ITEMS_BY_KIND_PAYLOAD_SQL)
  return budgetItemsByKindPage(
    itemsByKindPayloads(chosen, (itemId) => payload.get(...prefix, itemId)),
    nextOrdinal,
    undefined,
    (row) =>
      measureJournalStoredRow(db, prefix, {
        payload_json: boundedStoredJson(row, 'payload_json'),
        output_blob: row.output_blob
      })
  )
}
