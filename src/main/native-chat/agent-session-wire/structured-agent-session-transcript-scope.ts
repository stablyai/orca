import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'

/** Keep child transcripts durable without presenting their speech as the parent's. */
export function scopeStructuredSessionTranscript(
  items: AgentJournalRenderItem[],
  record: Pick<AgentSessionRecord, 'providerHandleChain'> | null
): AgentJournalRenderItem[] {
  const threadIds = record?.providerHandleChain.flatMap((link) =>
    link.handle.provider === 'codex' ? [link.handle.threadId] : []
  )
  if (!threadIds?.length) {
    return items
  }
  const threads = new Set(threadIds)
  return items.filter((item) => {
    // Child approvals/questions must remain actionable from the owning session.
    if (!['message', 'tool-call', 'diff'].includes(item.body.kind)) {
      return true
    }
    const identity = parseAgentJournalItemKey(item.itemId)
    if (identity?.provider === 'codex') {
      return threads.has(identity.threadId)
    }
    if (identity?.provider === 'orca' && identity.clientMessageId.startsWith('codex-item:')) {
      return threadIds.some((id) => identity.clientMessageId.startsWith(`codex-item:${id}:`))
    }
    return true
  })
}
