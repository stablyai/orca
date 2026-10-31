import type { AgentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type {
  StructuredChatNamingFailure,
  StructuredAgentSessionEndedChild,
  StructuredAgentSessionProviderChild
} from './structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import type { StructuredAgentSessionChildWorkProducer } from './structured-agent-session-subagent-rows'
import type { StructuredAgentSessionStatusObserverOptions } from './structured-agent-session-status-observation'
import type { StructuredAgentSessionStatusSink } from './structured-agent-session-status-ownership'
import { structuredSummaryConversationNaming } from './structured-agent-session-status-summary'

export type StatusFeedSession = {
  journal: AgentSessionJournal
  params: {
    location: AgentSessionConversationView['location']
    provider: AgentSessionConversationView['provider']
  }
  child?: Pick<StructuredAgentSessionProviderChild, 'phase' | 'generation' | 'fence'> | null
  lastEndedChild?: Pick<StructuredAgentSessionEndedChild, 'fence' | 'rootGone'>
  operationalRevision?: number
  restartResume?: AgentSessionStatusSummary['restartResume']
}

export type StructuredAgentSessionStatusFeedDeps = {
  sessions: ReadonlyMap<string, StatusFeedSession>
  starting?: (sessionId: string) => boolean
  getConversation: (sessionId: string) => AgentSessionConversationView | null
  listConversations?: () => AgentSessionConversationView[]
  /** Absent means no replaced runtime. */
  replacedRuntime?: (sessionId: string) => { fence: number } | undefined
  now: () => number
  /** Observer/sink failure must not block subscriber events. */
  logger: StructuredAgentSessionLogger
  /** Observe even without subscribers; replay distinguishes restore/projection from fresh journal events. */
  onStatusChanged?: (
    summary: AgentSessionStatusSummary,
    options: StructuredAgentSessionStatusObserverOptions
  ) => void
  onPublished?: (summary: AgentSessionStatusSummary) => void
  /** Resolve after host field initialization; read child records from the sink holding their parent row. */
  statusSink?: () => StructuredAgentSessionStatusSink | undefined
  /** Republish changed child records; producer identifies their write path. */
  onChildWorkChanged?: (
    sessionId: string,
    producer?: StructuredAgentSessionChildWorkProducer
  ) => void
  namingActiveSessionIds?: () => string[]
  namingFailure?: (sessionId: string) => StructuredChatNamingFailure | undefined
  onAgentStarted?: (sessionId: string) => void
}

export type StructuredAgentSessionStatusSubscriber = {
  id: string
  emit: (event: AgentSessionStatusEvent) => void
}

export type StatusPublication = {
  summary: AgentSessionStatusSummary
  firstInputSubmissionKey: string | null
}

/** Naming activity does not depend on any readable journal or retained summary. */
export function structuredAgentSessionNamingSnapshot(
  deps: StructuredAgentSessionStatusFeedDeps,
  sessionId?: string
): AgentSessionStatusEvent {
  const record = sessionId === undefined ? null : deps.getConversation(sessionId)
  const records =
    sessionId === undefined ? (deps.listConversations?.() ?? []) : record ? [record] : []
  const conversationNames = records.map((entry) => ({
    sessionId: entry.sessionId,
    conversationName: entry.conversationName ?? null,
    ...structuredSummaryConversationNaming(entry, deps.namingFailure?.(entry.sessionId))
  }))
  return {
    type: 'snapshot',
    sessions: [],
    namingActiveSessionIds: deps.namingActiveSessionIds?.() ?? [],
    ...(conversationNames.length ? { conversationNames } : {})
  }
}

/** Activity observers remain separate from descriptive provider reports. */
export function notifyStructuredStatusObservers(
  deps: StructuredAgentSessionStatusFeedDeps,
  summary: AgentSessionStatusSummary,
  previous: AgentSessionStatusSummary | undefined,
  options: StructuredAgentSessionStatusObserverOptions & { reportOnly: boolean }
): void {
  if (summary.hostExecutionPhase === 'ready' && previous?.hostExecutionPhase !== 'ready') {
    deps.onAgentStarted?.(summary.sessionId)
  }
  const { reportOnly, ...observation } = options
  if (reportOnly) {
    return
  }
  try {
    deps.onStatusChanged?.(summary, observation)
  } catch (error) {
    deps.logger.warn('status observer failed', {
      scope: 'status-observer',
      sessionId: summary.sessionId,
      error
    })
  }
}

export function notifyStructuredStatusPublication(
  deps: StructuredAgentSessionStatusFeedDeps,
  summary: AgentSessionStatusSummary
): void {
  try {
    deps.onPublished?.(summary)
  } catch (error) {
    deps.logger.warn('saving chat status failed', {
      scope: 'saved-status',
      sessionId: summary.sessionId,
      error
    })
  }
}
