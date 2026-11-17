import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

/**
 * A row-count page of tool output can reach hundreds of MB, which main decodes on its shared heap;
 * rows past this much JSON go to the next page, far below the reader reply limit. A lone larger
 * row still goes alone, so the visit always advances.
 */
export const ITEMS_BY_KIND_PAGE_JSON_BUDGET = 8 * 2 ** 20

/** `rows` are the chosen items in ordinal order; `nextOrdinal` resumes after the last chosen. */
export function budgetItemsByKindPage(
  rows: readonly Record<string, unknown>[],
  nextOrdinal: number | null,
  budget = ITEMS_BY_KIND_PAGE_JSON_BUDGET
): { items: AgentJournalRenderItem[]; nextOrdinal: number | null } {
  const items: AgentJournalRenderItem[] = []
  let used = 0
  for (const row of rows) {
    const json = String(row.payload_json)
    if (items.length > 0 && used + json.length > budget) {
      return { items, nextOrdinal: Number(rows[items.length - 1]!.ordinal) }
    }
    used += json.length
    items.push(JSON.parse(json))
  }
  return { items, nextOrdinal }
}
