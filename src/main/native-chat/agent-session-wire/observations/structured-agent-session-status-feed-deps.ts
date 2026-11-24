import type { HostUsageLimitCut } from '../recovery/structured-agent-session-usage-limit-chain'
import type { AgentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { JournalObserverResult } from '../../agent-session-journal/journal-observer-read'
import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import type {
  StructuredChatNamingFailure,
  StructuredAgentSessionEndedChild,
  StructuredAgentSessionProviderChild,
  QuietTurnEnd
} from '../host/structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'
import type { StructuredAgentSessionChildWorkProducer } from './structured-agent-session-subagent-rows'
import type { StructuredAgentSessionStatusObserverOptions } from './structured-agent-session-status-observation'
import type { StructuredAgentSessionStatusSink } from './structured-agent-session-status-ownership'
import { structuredSummaryConversationNaming } from './structured-agent-session-status-summary'

export type StatusFeedSession = {
  journal: AgentSessionJournal | SqlAgentSessionJournal
  params: {
    location: AgentSessionConversationView['location']
    provider: AgentSessionConversationView['provider']
  }
  child?: Pick<
    StructuredAgentSessionProviderChild,
    'phase' | 'generation' | 'fence' | 'heldSends'
  > | null
  lastEndedChild?: Pick<StructuredAgentSessionEndedChild, 'fence' | 'rootGone' | 'cause'>
  operationalRevision?: number
  restartResume?: AgentSessionStatusSummary['restartResume']
}

export type StructuredAgentSessionStatusFeedDeps = {
  sessions: ReadonlyMap<string, StatusFeedSession>
  starting?: (sessionId: string) => boolean
  holdsDispatch?: (sessionId: string) => boolean | 'history-catch-up'
  getConversation: (sessionId: string) => AgentSessionConversationView | null
  listConversations?: () => AgentSessionConversationView[]
  /** Reading a closed chat reopens it; true keeps its existing row updating but adds no new one. */
  rowRetired?: (sessionId: string) => boolean
  /** Absent means no replaced runtime. */
  replacedRuntime?: (sessionId: string) => { fence: number } | undefined
  /** See `StructuredAgentSessionHostDeps.quietTurnEnd`. */
  quietTurnEnd?: QuietTurnEnd
  /** See `StructuredAgentSessionHostDeps.isBotHome`. */
  isBotHome?: (workspaceId: string) => boolean
  readUsageLimitContinue?: (
    id: string,
    cut: HostUsageLimitCut | null
  ) => AgentSessionStatusSummary['usageLimitContinue']
  /** Absent: the running child applies the mode it launched with. */
  runningPermissionMode?: (sessionId: string) => string | undefined
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
  drainChildWork?: (sessionId?: string) => Promise<void>
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
  /** The current work the published summary was read with; absent until a live read. */
  work?: JournalObserverResult['work']
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
    agent: entry.provider,
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
