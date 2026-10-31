import type { AgentMessageSender } from '../../../shared/agent-session/agent-session-message-source'
import { defaultAgentChatLabel } from '../../../shared/agent-session/agent-session-chat-label'
import {
  getAgentRowConversationName,
  type ConversationNameTab
} from '../../../shared/agent-row-conversation-name'
import type { AgentType } from '../../../shared/agent-status-types'
import { formatAgentTypeLabel } from '../../../shared/agent-type-label'
import { structuredChatDisplayName } from '../../../shared/structured-chat-row-name'
import type { Tab } from '../../../shared/tab-types'
import type { OrchestrationDb } from './db'
import type { DispatchContextRow } from './types'
import { lineageLiveSession, type AgentSessionRecordReader } from './structured-session-lineage'

export type TerminalSenderNaming = {
  /** The tab as this host mirrors the workspace session. */
  tab: ConversationNameTab | null
  /** Its current pane title; undefined lets a single pane use its mirrored tab title. */
  paneTitle?: string | null
  providerSessionId?: string
  agent: AgentType | null
  /** Its pane, which an active dispatch still names after the handle was reissued. */
  paneKey: string | null
}

export type SenderNamingSources = {
  db: OrchestrationDb | null
  records: AgentSessionRecordReader | null
  /** The chat's tab as this host mirrors the workspace session. */
  chatTab: (worktreeId: string, sessionId: string) => Pick<Tab, 'customLabel' | 'label'> | null
  terminal: (handle: string) => TerminalSenderNaming | null
  generatedTitlesEnabled: boolean
}

type Party = AgentMessageSender['party']

/** `reportedDispatchId`: the dispatch the sender's own `worker_done` in the batch names. */
export function orchestrationSenderName(
  party: Party,
  sources: SenderNamingSources,
  reportedDispatchId?: string
): string | null {
  const federated = party.address.startsWith('dispatch:')
  const terminal =
    !federated && party.terminalHandle ? sources.terminal(party.terminalHandle) : null
  const chat = party.orcaSessionId ? structuredChatNaming(party.orcaSessionId, sources) : null
  const terminalName = terminal?.tab
    ? getAgentRowConversationName(
        terminal.tab,
        terminal.agent,
        sources.generatedTitlesEnabled,
        terminal.paneTitle,
        terminal.providerSessionId
      )
    : null
  return (
    chat?.ownName ||
    terminalName ||
    dispatchTaskName(party, federated, terminal, sources.db, reportedDispatchId) ||
    chat?.fallback ||
    (terminal?.agent ? formatAgentTypeLabel(terminal.agent) : null)
  )
}

/** A chat's own name (the person's rename, else its saved name) and the label its tab falls back to. */
export function structuredChatNaming(
  sessionId: string,
  sources: Pick<SenderNamingSources, 'records' | 'chatTab'>
): { ownName: string | null; fallback: string } | null {
  const record = sources.records ? lineageLiveSession(sources.records, sessionId) : null
  if (!record) {
    return null
  }
  const tab = sources.chatTab(record.location.workspaceId, record.sessionId)
  const fallback = tab?.label.trim() || defaultAgentChatLabel(record.provider)
  const ownName = structuredChatDisplayName(tab?.customLabel, record.conversationName, '') || null
  return { ownName, fallback }
}

/** Use the live Dispatch or the sender's own just-settled worker_done; historical assignments may never have run. */
function dispatchTaskName(
  party: Party,
  federated: boolean,
  terminal: TerminalSenderNaming | null,
  db: OrchestrationDb | null,
  reportedDispatchId: string | undefined
): string | null {
  if (!db) {
    return null
  }
  const handle = party.terminalHandle
  const paneKey = terminal?.paneKey ?? undefined
  const dispatch = federated
    ? db.getDispatchContextById(party.address.slice('dispatch:'.length))
    : handle
      ? (db.getActiveDispatchForTerminal(handle, paneKey) ??
        reportedDispatch(db, reportedDispatchId, handle, paneKey))
      : undefined
  const task = dispatch ? db.getTask(dispatch.task_id) : undefined
  return task?.display_name || task?.task_title || null
}

/** Only the sender's own dispatch: a report's payload is the sender's to write. */
function reportedDispatch(
  db: OrchestrationDb,
  dispatchId: string | undefined,
  handle: string,
  paneKey: string | undefined
): DispatchContextRow | undefined {
  const dispatch = dispatchId ? db.getDispatchContextById(dispatchId) : undefined
  return dispatch &&
    (dispatch.assignee_handle === handle ||
      (paneKey !== undefined && dispatch.assignee_pane_key === paneKey))
    ? dispatch
    : undefined
}
