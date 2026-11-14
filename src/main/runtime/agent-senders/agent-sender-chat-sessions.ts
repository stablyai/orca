import 'node:crypto'
import '../../../shared/orchestration/workers/structured-worker-handle'
import '../../../shared/workspace-layout/stable-pane-id'
import '../../../shared/orchestration/workers/worker-terminal-host-scope'
import 'zod'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/agent-session/view/structured-agent-session-projection'
import type { AgentSessionRecordReader } from '../orchestration/addressing/session-lineage/structured-session-lineage'
import { createCanonicalSessionResolver } from '../orchestration/addressing/session-lineage/structured-session-lineage'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { AgentSenderAssociation } from '../../../shared/agent-sender-associations'

/** Chats with an open tab. Without a recorded tab table the store still knows the workspace's
 *  saved chat tabs, so closed history never counts as open; a reader that can't say counts all. */
function visibleChats(records: AgentSessionRecordReader | null): Set<string> | null {
  const listed = records?.listVisibleSessionIds?.()
  if (listed) {
    return new Set(listed)
  }
  const visibility = records?.getVisibleSessionTabIndex?.()
  return visibility?.present ? new Set(visibility.sessionIds) : null
}

/** Every open chat and, through the store's reverse /clear index, each session whose lineage
 *  reaches one: a row's chat is where its lineage runs now, so no other saved chat yields a row.
 *  Null for a reader without the index or visibility, which lists every chat. */
function senderCandidates(
  records: AgentSessionRecordReader | null,
  visible: Set<string> | null
): Set<string> | null {
  const clearedFrom = records?.listClearedFrom
  if (!visible || !clearedFrom) {
    return null
  }
  const seen = new Set<string>()
  const pending = [...visible]
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (!seen.has(id)) {
      seen.add(id)
      pending.push(...clearedFrom(id))
    }
  }
  return seen
}

/** Visible chats under their own and every /clear predecessor's session id. */
export function readAgentSenderSessions(
  records: AgentSessionRecordReader | null,
  work?: { chatRecords: number }
): AgentSenderAssociation[] {
  const visible = visibleChats(records)
  const ids =
    senderCandidates(records, visible) ?? (records?.listRecords() ?? []).map((r) => r.sessionId)
  const resolve = createCanonicalSessionResolver(records)
  return [...ids].flatMap((sessionId) => {
    if (work) {
      work.chatRecords++
    }
    const destinationId = resolve(sessionId)
    const destination = records?.getRecord(destinationId)
    return !destination ||
      // Local chats, WSL ones included, as the sidebar shows them.
      destination.location.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
      (visible && !visible.has(destinationId))
      ? []
      : [
          {
            identity: `orca_session_id:${sessionId}`,
            paneKey: structuredAgentSessionPaneKey(
              structuredAgentSessionTabId(destinationId),
              destinationId
            ),
            worktreeId: destination.location.workspaceId,
            sessionId: destinationId
          }
        ]
  })
}
