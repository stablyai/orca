import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  normalizeNativeChatTaskList,
  type NativeChatTaskList
} from '../../../shared/native-chat/input/task-lists/native-chat-task-list'
import type { JournalSqlScope } from './journal-sql-scope'

// A turn rarely runs more tools than this after it last wrote its plan; past it the plan reads as none.
const NEWEST_TOOL_CALLS = 300

/** The plan last written in the turn that ran the chat's newest tool call (its todo list), or null:
 *  from that turn's newest task-list call, never an earlier turn's. Read it when that newest call is
 *  the running turn's; a turn that has run no tool yet still answers with the turn before it. */
export function readJournalDomainLatestTaskList(scope: JournalSqlScope): NativeChatTaskList | null {
  const rows = scope.db
    .prepare(`SELECT payload_json,turn_item_id FROM journal_items
    WHERE session_id=? AND epoch=? AND hidden=0 AND root=1 AND kind='tool-call'
    ORDER BY sequence DESC,sequence_index DESC,ordinal DESC LIMIT ?`)
    .all(...scope.prefix, NEWEST_TOOL_CALLS)
  const turn = rows[0]?.turn_item_id
  for (const row of rows) {
    if (row.turn_item_id !== turn) {
      return null
    }
    const { body } = scope.decode<AgentJournalRenderItem>(scope.examined(row).payload_json)
    const list =
      body.kind === 'tool-call' ? normalizeNativeChatTaskList(body.name, body.input) : null
    if (list) {
      return list
    }
  }
  return null
}
