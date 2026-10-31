import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { agentVerdictFields } from '../../shared/agent-main-agent-verdict'
import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionAgentTabStatus
} from '../../shared/runtime-types'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'

/** A chat tab with the state it shows: the host's own structured row for its session, as desktop draws it. */
export function withStructuredChatStatus(
  tab: RuntimeMobileSessionAgentTab,
  worktreeId: string,
  getRowsForPane: (paneKey: string) => readonly AgentStatusIpcPayload[]
): RuntimeMobileSessionAgentTab {
  const host = getStructuredAgentSessionHost()
  const record = host?.deps.store.getRecord(tab.sessionId)
  tab = {
    ...tab,
    ...(record?.sideChat ? { sideChatOf: record.sideChat.sourceSessionId } : {}),
    ...(host?.deps.agents.capabilities(tab.agent)?.sideChat === true
      ? { sideChatSupported: true }
      : {})
  }
  const paneKey = structuredAgentSessionPaneKey(
    structuredAgentSessionTabId(tab.sessionId),
    tab.sessionId
  )
  let row: AgentStatusIpcPayload | undefined
  for (const candidate of getRowsForPane(paneKey)) {
    if (
      candidate.worktreeId === worktreeId &&
      candidate.restoredUnconfirmed !== true &&
      candidate.providerSessionOnly !== true &&
      (!row || candidate.receivedAt > row.receivedAt)
    ) {
      row = candidate
    }
  }
  if (!row) {
    return tab
  }
  const chatStatus: RuntimeMobileSessionAgentTabStatus = {
    state: row.state,
    ...(row.workingMode ? { workingMode: row.workingMode } : {}),
    ...agentVerdictFields(row),
    updatedAt: row.receivedAt,
    ...(row.evidenceObservedAt !== undefined ? { evidenceObservedAt: row.evidenceObservedAt } : {}),
    ...(row.structuredHost === 'owned' ? { structuredHostOwned: true as const } : {})
  }
  return { ...tab, chatStatus }
}
