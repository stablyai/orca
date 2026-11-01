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
import {
  logWorkerLaunchObservationFailure,
  workerStartOptionsAgent
} from './worker-launch-observation'

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

export type SenderObservation = {
  chat: ReturnType<typeof structuredChatNaming>
  terminal: TerminalSenderNaming | null
  dispatch: DispatchContextRow | null
}

/** Resolve nullable sources once; a missing observation is shared by both projections. */
export function observeOrchestrationSender(
  party: Party,
  sources: SenderNamingSources,
  reportedDispatchId?: string
): SenderObservation {
  const chat = party.orcaSessionId ? structuredChatNaming(party.orcaSessionId, sources) : null
  const federated = party.address.startsWith('dispatch:')
  const terminal =
    !federated && party.terminalHandle ? sources.terminal(party.terminalHandle) : null
  const db = sources.db
  const handle = party.terminalHandle
  const paneKey = terminal?.paneKey ?? undefined
  let dispatch: DispatchContextRow | null | undefined
  return {
    chat,
    terminal,
    get dispatch() {
      if (dispatch === undefined) {
        dispatch = !db
          ? null
          : federated
            ? (db.getDispatchContextById(party.address.slice('dispatch:'.length)) ?? null)
            : handle
              ? (db.getActiveDispatchForTerminal(handle, paneKey) ??
                reportedDispatch(db, reportedDispatchId, handle, paneKey) ??
                null)
              : null
      }
      return dispatch
    }
  }
}

/** `reportedDispatchId`: the dispatch the sender's own `worker_done` in the batch names. */
export function orchestrationSenderName(
  party: Party,
  sources: SenderNamingSources,
  reportedDispatchId?: string,
  observation = observeOrchestrationSender(party, sources, reportedDispatchId)
): string | null {
  const { chat, terminal } = observation
  const terminalName = terminal?.tab
    ? getAgentRowConversationName(
        terminal.tab,
        terminal.agent,
        sources.generatedTitlesEnabled,
        terminal.paneTitle,
        terminal.providerSessionId
      )
    : null
  const ownName = chat?.ownName || terminalName
  if (ownName) {
    return ownName
  }
  const dispatch = observation.dispatch
  const task = dispatch ? sources.db?.getTask(dispatch.task_id) : null
  return (
    task?.display_name ||
    task?.task_title ||
    chat?.fallback ||
    (terminal?.agent ? formatAgentTypeLabel(terminal.agent) : null)
  )
}

/** Current live kind wins; exact durable dispatch knowledge survives loss of live observations. */
export function orchestrationSenderAgent(
  sources: Pick<SenderNamingSources, 'db'>,
  observation: SenderObservation
): AgentType | null {
  const live = observation.chat?.agent || observation.terminal?.agent
  if (live) {
    return live
  }
  try {
    const worker = observation.dispatch
      ? sources.db?.getWorkerDispatch(observation.dispatch.id)
      : null
    return worker ? workerStartOptionsAgent(worker.start_options) : null
  } catch (error) {
    logWorkerLaunchObservationFailure(error)
    return null
  }
}

/** A chat's own name (the person's rename, else its saved name) and the label its tab falls back to. */
export function structuredChatNaming(
  sessionId: string,
  sources: Pick<SenderNamingSources, 'records' | 'chatTab'>
): { ownName: string | null; fallback: string; agent: AgentType } | null {
  const record = sources.records ? lineageLiveSession(sources.records, sessionId) : null
  if (!record) {
    return null
  }
  const tab = sources.chatTab(record.location.workspaceId, record.sessionId)
  const fallback = tab?.label.trim() || defaultAgentChatLabel(record.provider)
  const ownName = structuredChatDisplayName(tab?.customLabel, record.conversationName, '') || null
  return { ownName, fallback, agent: record.provider }
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
