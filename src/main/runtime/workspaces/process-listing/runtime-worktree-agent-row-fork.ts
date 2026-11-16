import { structuredAgentSessionIdFromTabId } from '../../../../shared/agent-session/view/structured-agent-session-tab-id'
import {
  readAgentSessionRecordStore,
  resolveLineageRunningSession,
  type AgentSessionRecordReader
} from '../../orchestration/addressing/session-lineage/structured-session-lineage'

/** Whether worktree.ps rows name forked native chats, so phones draw the fork mark: the chat the
 *  row's tab now runs, as its name reads it. */
export function runtimeWorktreeAgentRowForked(
  records: AgentSessionRecordReader | null = readAgentSessionRecordStore()
): (tabId: string | null | undefined) => boolean {
  return (tabId) => {
    const sessionId = tabId ? structuredAgentSessionIdFromTabId(tabId) : null
    if (!sessionId || !records) {
      return false
    }
    const running = resolveLineageRunningSession(records, sessionId)
    return running.kind === 'here' && running.record.forkedFrom !== undefined
  }
}
