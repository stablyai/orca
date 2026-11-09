import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  nativeChatTurnReplyPreviews,
  projectAgentSessionConversationOutline
} from '../../../shared/agent-session/agent-session-conversation-outline'
import { projectStructuredItemToNativeChat } from '../../../shared/agent-session/view/structured-agent-session-projection'
import { journalDomainContextHead } from './journal-sql-continuation-context'
import { boundJournalConversationOutline } from './journal-outline-budget'
import type { JournalSqlScope } from './journal-sql-scope'

/** Outline membership uses saved placement; only prompts, turns and winning reply prose need bodies. */
export function readJournalDomainOutline(scope: JournalSqlScope, budgetBytes: number) {
  const { db, prefix } = scope
  const rows = db
    .prepare(`SELECT item_id,revision,sequence,placement_json,assistant_prose,
      CASE WHEN (kind='message' AND message_role='user') OR turn_marker=1 OR context_clear=1
        THEN payload_json END AS payload_json
      FROM journal_items INDEXED BY journal_items_root_position
      WHERE session_id=? AND epoch=? AND hidden=0 AND root=1
        AND ((kind='message' AND message_role IN ('user','assistant'))
          OR turn_marker=1 OR context_clear=1 OR turn_scope_kind='unknown')
      ORDER BY sequence,sequence_index,ordinal`)
    .all(...prefix)
  const prose = new Set(
    rows.filter((row) => row.assistant_prose === 1).map((row) => String(row.item_id))
  )
  const items = rows.map((row): AgentJournalRenderItem => {
    scope.examined(row)
    if (row.payload_json !== null) {
      return scope.decode<AgentJournalRenderItem>(row.payload_json)
    }
    return {
      ...scope.decode<Omit<AgentJournalRenderItem, 'body'>>(row.placement_json),
      revision: Number(row.revision),
      sequence: Number(row.sequence),
      body: { kind: 'message', role: 'assistant', blocks: [] }
    }
  })
  const submissions = db
    .prepare(`SELECT payload_json FROM journal_submission_attempts
      INDEXED BY journal_submission_ordinal WHERE session_id=? AND epoch=? AND current=1
      ORDER BY ordinal`)
    .all(...prefix)
    .map((row) => scope.decode<AgentJournalSubmission>(scope.examined(row).payload_json))
  const body = db.prepare(`SELECT payload_json FROM journal_items
    WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0`)
  const entries = projectAgentSessionConversationOutline(items, submissions, (messages, keys) => {
    const replies = new Map<string, string>()
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      const key = keys[index]
      if (
        message.role !== 'assistant' ||
        key === undefined ||
        replies.has(key) ||
        !prose.has(message.id)
      ) {
        continue
      }
      const row = body.get(...prefix, message.id)
      if (!row) {
        continue
      }
      const saved = projectStructuredItemToNativeChat(
        scope.decode<AgentJournalRenderItem>(scope.examined(row).payload_json)
      )
      if (saved) {
        const reply = nativeChatTurnReplyPreviews([saved], [key]).get(key)
        if (reply !== undefined) {
          replies.set(key, reply)
        }
      }
    }
    return replies
  })
  return boundJournalConversationOutline(
    { sessionId: scope.sessionId, cursor: journalDomainContextHead(db, scope) },
    entries,
    budgetBytes
  )
}
