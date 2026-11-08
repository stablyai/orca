import type { JournalSqlScope } from './journal-sql-scope'
import { JOURNAL_HISTORY_ITEMS_LIMIT } from './journal-history-items'

/** Only item IDs cross the deterministic prompt lookup; historical bodies stay in SQLite. */
export function* journalSqlUserItemIds(
  scope: JournalSqlScope,
  visible: (key: string) => boolean
): Iterable<string> {
  for (const row of scope.db
    .prepare(`SELECT entry_key FROM journal_proj_items
    WHERE session_id=? AND epoch=? AND kind='message' AND message_role='user' ORDER BY ordinal`)
    .iterate(...scope.prefix)) {
    scope.examined(row)
    const key = String(JSON.parse(String(row.entry_key)))
    if (visible(key)) {
      yield key
    }
  }
}

/** Opener aliases and turn membership both have typed indexes. */
export function journalSqlHistoryOpeners(scope: JournalSqlScope, itemId: string): string[] {
  const openers = [itemId]
  for (const row of scope.db
    .prepare(`SELECT alias FROM journal_proj_aliases
    WHERE session_id=? AND epoch=? AND target=? LIMIT ?`)
    .iterate(...scope.prefix, itemId, JOURNAL_HISTORY_ITEMS_LIMIT + 1)) {
    scope.examined(row)
    openers.push(String(row.alias))
    if (openers.length > JOURNAL_HISTORY_ITEMS_LIMIT) {
      throw new Error('history-workspace-too-large')
    }
  }
  const turns = new Map<string, number>()
  for (const opener of openers) {
    for (const row of scope.db
      .prepare(`SELECT entry_key, ordinal FROM journal_proj_items
      WHERE session_id=? AND epoch=? AND opener_item_id=? ORDER BY ordinal LIMIT ?`)
      .iterate(...scope.prefix, opener, JOURNAL_HISTORY_ITEMS_LIMIT + 1)) {
      scope.examined(row)
      turns.set(String(JSON.parse(String(row.entry_key))), Number(row.ordinal))
      if (turns.size > JOURNAL_HISTORY_ITEMS_LIMIT) {
        throw new Error('history-workspace-too-large')
      }
    }
  }
  return [...turns].sort((a, b) => a[1] - b[1]).map(([key]) => key)
}
