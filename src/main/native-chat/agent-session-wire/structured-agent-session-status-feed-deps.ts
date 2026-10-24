import type { AgentSessionRecord } from '../../../shared/agent-session-record'
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

export type StatusFeedSession = {
  journal: AgentSessionJournal
  params: { location: AgentSessionRecord['location']; provider: AgentSessionRecord['provider'] }
  child?: Pick<StructuredAgentSessionProviderChild, 'phase' | 'generation' | 'fence'> | null
  lastEndedChild?: Pick<StructuredAgentSessionEndedChild, 'fence' | 'rootGone'>
  operationalRevision?: number
  restartResume?: AgentSessionStatusSummary['restartResume']
}

export type StructuredAgentSessionStatusFeedDeps = {
  sessions: ReadonlyMap<string, StatusFeedSession>
  starting?: (sessionId: string) => boolean
  getRecord: (sessionId: string) => AgentSessionRecord | null
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

/** Naming snapshots need neither readable journals nor retained status rows. */
export function structuredAgentSessionNamingSnapshot(
  deps: StructuredAgentSessionStatusFeedDeps
): AgentSessionStatusEvent {
  return {
    type: 'snapshot',
    sessions: [],
    namingActiveSessionIds: deps.namingActiveSessionIds?.() ?? []
  }
}
