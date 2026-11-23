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

// Kinds a Stop or close rejects unsent sends with. Orca's own stops use them too, so only a person's
// saved Stop, made after the send, makes one read as stopped.
const STOP_REJECTIONS: ReadonlySet<AgentSessionFailureKind> = new Set(['cancelled', 'chatClosed'])

type StopReadingChat = {
  journalReads(sessionId: string): Promise<Pick<JournalSqlReads, 'latestStop'>>
}

export type SavedStop = Pick<JournalStopEvent, 'reason' | 'at'> | null | undefined

/** The chat's latest saved Stop; unreadable reads as none, so the send keeps its failure. */
export async function savedStop(chat: StopReadingChat, sessionId: string): Promise<SavedStop> {
  try {
    return (await (await chat.journalReads(sessionId)).latestStop())?.event
  } catch {
    return null
  }
}

/** A send a person's Stop or close took back before the agent ran it: stopped, never an error. */
export function personStopTookBack(
  fact: AgentSessionFailureFact | undefined,
  submittedAt: number,
  stop: SavedStop
): boolean {
  return (
    fact !== undefined &&
    STOP_REJECTIONS.has(fact.kind) &&
    !!stop &&
    stopIsAPersons(stop.reason) &&
    stop.at >= submittedAt
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
  submission: AgentJournalSubmission | null | undefined
): Promise<Delivery> {
  const fact = readAgentSessionFailureFact(submission?.rejection)
  const stop = fact && STOP_REJECTIONS.has(fact.kind) ? await savedStop(chat, link.sessionId) : null
  return submission && personStopTookBack(fact, submission.submittedAt, stop)
    ? refused('conversation_cancelled')
    : refused('agent_not_reachable', fact && connectorFailure(fact, link.agent))
}
