import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { JournalSqlStatusContext } from '../journal-sql-status-context'
import type { JournalSqlScope } from '../journal-sql-scope'

/** Load the lifecycle families, plus named opener proof; ordinary message history stays in SQL. */
export function journalGenerationSettlementItems(scope: JournalSqlScope): AgentJournalRenderItem[] {
  const context = new JournalSqlStatusContext(scope)
  const items: AgentJournalRenderItem[] = []
  let after: number[] | undefined
  for (;;) {
    const rows = scope.db
      .prepare(`SELECT entry_key,sequence,sequence_index,ordinal
      FROM journal_proj_items WHERE session_id=? AND epoch=? AND hidden=0 AND
      (kind IN ('status','turn','tool-call','approval','question') OR
        (kind='message' AND (lifecycle_state='running' OR live_work=1)))
      ${after ? 'AND (sequence,sequence_index,ordinal)>(?,?,?)' : ''}
      ORDER BY sequence,sequence_index,ordinal LIMIT 128`)
      .all(...scope.prefix, ...(after ?? []))
    for (const row of rows) {
      scope.examined(row)
      const item = context.displayed(String(JSON.parse(String(row.entry_key))))
      if (item) {
        items.push(item)
      }
    }
    const last = rows.at(-1)
    if (rows.length < 128 || !last) {
      break
    }
    after = [Number(last.sequence), Number(last.sequence_index), Number(last.ordinal)]
  }
  const present = new Set(items.map((item) => item.itemId))
  for (const item of items) {
    const openerId = readAgentJournalTurn(item.body)?.userItemId
    if (openerId && !present.has(openerId)) {
      const opener = context.displayed(openerId)
      if (opener) {
        items.push(opener)
        present.add(openerId)
      }
    }
  }
  return items
}
