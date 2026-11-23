// Why a connector conversation's agent couldn't do what was asked, from the chat's typed failure facts
// (never its text), in the categories the connectors word.
import {
  readAgentSessionFailureFact,
  type AgentSessionFailureFact,
  type AgentSessionFailureKind
} from '../../shared/agent-session/failures/agent-session-failure'
import type { AgentJournalSubmission } from '../../shared/agent-session/journal/agent-session-journal-types'
import type {
  ConnectorFailure,
  ConnectorFailureCategory
} from '../../shared/connectors/connector-cloud-contract'
import { tuiAgentDisplayName } from '../../shared/agent-launch/catalog/tui-agent-display-names'
import { refused, type Delivery } from './external-conversation-types'
import type { JournalSqlReads } from '../native-chat/agent-session-journal/journal-sql-reads'
import type { JournalStopEvent } from '../native-chat/agent-session-journal/durable-rows/journal-row-schema'
import { stopIsAPersons } from '../native-chat/agent-session-journal/context-epochs/journal-stop-turn-end'

// Each a different next step for the owner; any other kind is the agent's own error.
const CATEGORY_OF: Partial<Record<AgentSessionFailureKind, ConnectorFailureCategory>> = {
  notSignedIn: 'signed_out',
  usageLimitReached: 'usage_limit',
  cliMissing: 'not_set_up',
  runtimeNotInstalled: 'not_set_up',
  agentCommandNotRunnable: 'not_set_up',
  claudeAccountFolderMissing: 'not_set_up',
  claudeAccountSetupFailed: 'not_set_up',
  launchFolderMissing: 'folder_missing'
}

// Kinds a Stop or close rejects unsent sends with. Orca's own stops use them too, so only a
// person's saved Stop between the send and its rejection makes one read as stopped.
const STOP_REJECTIONS: ReadonlySet<AgentSessionFailureKind> = new Set(['cancelled', 'chatClosed'])

type RejectedSend = Pick<AgentJournalSubmission, 'rejection' | 'submittedAt' | 'resolvedAt'>
type StopReadingChat = {
  journalReads(sessionId: string): Promise<Pick<JournalSqlReads, 'latestStop'>>
}
export type SavedStop = Pick<JournalStopEvent, 'reason' | 'at'> | null

/** Whether a rejection could be a Stop's, so the saved Stop is worth reading. */
export function stopMayHaveRejected(send: Pick<RejectedSend, 'rejection'>): boolean {
  const fact = readAgentSessionFailureFact(send.rejection)
  return fact !== undefined && STOP_REJECTIONS.has(fact.kind)
}

/** The chat's latest saved Stop; unreadable reads as none, so the send keeps its failure. */
export async function savedStop(chat: StopReadingChat, sessionId: string): Promise<SavedStop> {
  try {
    return (await (await chat.journalReads(sessionId)).latestStop())?.event ?? null
  } catch (error) {
    console.warn('[connectors] could not read the chat’s latest Stop', error)
    return null
  }
}

/** A send a person's Stop or close took back before the agent ran it: stopped, never an error. */
export function personStopTookBack(send: RejectedSend, stop: SavedStop): boolean {
  return (
    stopMayHaveRejected(send) &&
    stop !== null &&
    stopIsAPersons(stop.reason) &&
    stop.at >= send.submittedAt &&
    (send.resolvedAt === null || stop.at <= send.resolvedAt)
  )
}

export function connectorFailure(
  fact: AgentSessionFailureFact | undefined,
  agent: string
): ConnectorFailure {
  const agentName = tuiAgentDisplayName(agent)
  const limit = fact?.kind === 'usageLimitReached' ? fact.usageLimit : undefined
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return {
    category: (fact && CATEGORY_OF[fact.kind]) ?? 'agent_error',
    ...(agentName ? { agentName } : {}),
    ...(limit ? { usageLimit: limit } : {}),
    ...(timeZone ? { timeZone } : {})
  }
}

/** Why the connector hears a send the chat rejected: stopped for a person's Stop, else why it failed. */
export async function rejectedSendRefusal(
  chat: StopReadingChat,
  link: { sessionId: string; agent: string },
  send: RejectedSend | null | undefined
): Promise<Delivery> {
  const fact = readAgentSessionFailureFact(send?.rejection)
  if (send && fact && STOP_REJECTIONS.has(fact.kind)) {
    if (personStopTookBack(send, await savedStop(chat, link.sessionId))) {
      return refused('conversation_cancelled')
    }
  }
  return refused('agent_not_reachable', fact && connectorFailure(fact, link.agent))
}
