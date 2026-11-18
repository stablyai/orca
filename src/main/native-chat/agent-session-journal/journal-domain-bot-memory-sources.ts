import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  type BotMemorySources,
  gatherBotMemorySources
} from '../../../shared/bots/bot-memory-source'
import type { JournalSqlScope } from './journal-sql-scope'

const PAGE = 256

/** The outside sources of the epoch's person messages after `after` (all when null), in journal
 *  order: only user-message rows are decoded, a page at a time, and only what a label can show is
 *  held or leaves the worker. */
export function readJournalDomainBotMemorySources(
  scope: JournalSqlScope,
  after: number | null
): BotMemorySources {
  const statement = scope.db.prepare(`SELECT sequence,sequence_index,ordinal,payload_json
    FROM journal_items INDEXED BY journal_items_visible_position
    WHERE session_id=? AND epoch=? AND hidden=0 AND kind='message' AND message_role='user'
    AND (sequence,sequence_index,ordinal)>(?,?,?) ORDER BY sequence,sequence_index,ordinal LIMIT ${PAGE}`)
  const gathered = gatherBotMemorySources()
  let position = [after ?? -1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
  for (;;) {
    const rows = statement.all(...scope.prefix, ...position)
    for (const row of rows) {
      const read = scope.examined(row)
      position = [Number(read.sequence), Number(read.sequence_index), Number(read.ordinal)]
      gathered.row(scope.decode<AgentJournalRenderItem>(read.payload_json).body)
    }
    if (rows.length < PAGE) {
      return gathered.read()
    }
  }
}
