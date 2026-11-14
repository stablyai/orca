import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isAdmissibleAgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-schemas'
import { firstStructuredAgentSessionPrompt } from '../../../shared/agent-session/requests/structured-agent-session-first-prompt'
import type { StructuredConversationJournalPreview } from '../../ai-vault/structured-conversation-journal-preview'
import type { JournalSqlScope } from './journal-sql-scope'

const ROW_LIMIT = 41
const ROW_TEXT_LIMIT = 65_536
const UNKNOWN = { conversationContent: 'unknown' as const }

/** Current domain facts replace event replay; each read stays in the worker's WAL snapshot. */
export function readJournalDomainConversationPreview(
  scope: JournalSqlScope,
  workspaceId: string
): StructuredConversationJournalPreview {
  const head = scope.db
    .prepare(`SELECT workspace_id,last_sequence,history_origin_json
    FROM journal_chat_state WHERE session_id=? AND epoch=?`)
    .get(...scope.prefix)
  if (!head || head.workspace_id !== workspaceId) {
    return UNKNOWN
  }
  const rows = scope.db
    .prepare(`SELECT substr(payload_json,1,?) AS payload
    FROM journal_items INDEXED BY journal_items_root_position
    WHERE session_id=? AND epoch=? AND hidden=0 AND root=1 AND sequence<?
    ORDER BY sequence,sequence_index,ordinal LIMIT ?`)
    .all(ROW_TEXT_LIMIT + 1, ...scope.prefix, ROW_LIMIT, ROW_LIMIT)
  const items: AgentJournalRenderItem[] = []
  for (const row of rows) {
    const payload = String(scope.examined(row).payload)
    if (payload.length > ROW_TEXT_LIMIT) {
      return UNKNOWN
    }
    const item = scope.parse(payload)
    if (!isAdmissibleAgentJournalRenderItem(item)) {
      return UNKNOWN
    }
    items.push(item)
  }
  const firstUserPrompt = firstStructuredAgentSessionPrompt(
    items.filter((item) => item.body.kind !== 'message' || item.body.from === undefined)
  )
  return {
    conversationContent:
      Number(head.last_sequence) >= ROW_LIMIT
        ? 'unknown'
        : items.length > 0
          ? 'present'
          : Number(head.last_sequence) <= 1 && head.history_origin_json === null
            ? 'empty'
            : 'unknown',
    ...(firstUserPrompt ? { firstUserPrompt } : {})
  }
}
