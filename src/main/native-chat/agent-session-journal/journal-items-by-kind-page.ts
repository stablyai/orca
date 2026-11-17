import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

/**
 * A row-count page of tool output can reach hundreds of MB, which main decodes on its shared heap;
 * rows past this much JSON go to the next page, far below the reader reply limit. A lone larger
 * row still goes alone, so the visit always advances.
 */
export const ITEMS_BY_KIND_PAGE_JSON_BUDGET = 8 * 2 ** 20

/** `rows` are the chosen items in ordinal order, read lazily so rows past the budget stay unread. */
export function budgetItemsByKindPage(
  rows: Iterable<Record<string, unknown>>,
  nextOrdinal: number | null,
  budget = ITEMS_BY_KIND_PAGE_JSON_BUDGET
): { items: AgentJournalRenderItem[]; nextOrdinal: number | null } {
  const items: AgentJournalRenderItem[] = []
  let used = 0
  let lastKept = -1
  for (const row of rows) {
    const json = String(row.payload_json)
    if (items.length > 0 && used + json.length > budget) {
      return { items, nextOrdinal: lastKept }
    }
    used += json.length
    lastKept = Number(row.ordinal)
    items.push(JSON.parse(json))
  }
  return { items, nextOrdinal }
}

/** Payload by primary key, so a page cut by the budget looks up no further rows. */
export const ITEMS_BY_KIND_PAYLOAD_SQL = `SELECT payload_json,ordinal FROM journal_items
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
