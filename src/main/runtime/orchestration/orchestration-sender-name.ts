// What a chat shows a message's sender as: names from Orca's own records, most specific first, and
// never a title the agent paints on its own terminal.

import type { AgentMessageSender } from '../../../shared/agent-session-message-source'
import { defaultAgentChatLabel } from '../../../shared/agent-session-chat-label'
import type { AgentType } from '../../../shared/agent-status-types'
import { formatAgentTypeLabel } from '../../../shared/agent-type-label'
import type { Tab } from '../../../shared/tab-types'
import type { OrchestrationDb } from './db'
import type { DispatchContextRow } from './types'
import {
  readStructuredAgentSessionRecord,
  type AgentSessionRecordReader
} from './structured-session-records'

export type TerminalSenderNaming = {
  /** The tab's stored title: a rename, by the person or through the CLI. Never its live title. */
  customTitle: string | null
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
  const task = dispatchTaskName(party, federated, terminal, sources.db, reportedDispatchId)
  if (task) {
    return task
  }
  if (party.orcaSessionId) {
    const record = sources.records
      ? readStructuredAgentSessionRecord(sources.records, party.orcaSessionId)
      : null
    if (record) {
      const tab = sources.chatTab(record.location.workspaceId, record.sessionId)
      return tab?.customLabel?.trim() || tab?.label.trim() || defaultAgentChatLabel(record.provider)
    }
  }
  if (terminal) {
    const agentLabel = terminal.agent ? formatAgentTypeLabel(terminal.agent) : null
    return terminal.customTitle?.trim() || agentLabel
  }
  return null
}

/** The task its dispatch was given: the federated `dispatch:<id>` address, or the dispatch a local
 *  worker holds, else the one its own `worker_done` reports, since that report settles its dispatch
 *  before it is delivered. Never a dispatch the worker merely held once: one may have failed
 *  before it ran, and an old one names work long done. */
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
