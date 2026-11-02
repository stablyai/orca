// What a status feed reads of the host: its held sessions, their records, and where it reports.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type {
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
  /** What the current-work projection reads of the last child this host saw end. */
  lastEndedChild?: Pick<StructuredAgentSessionEndedChild, 'fence' | 'rootGone'>
  operationalRevision?: number
  restartResume?: AgentSessionStatusSummary['restartResume']
}

export type StructuredAgentSessionStatusFeedDeps = {
  sessions: ReadonlyMap<string, StatusFeedSession>
  getRecord: (sessionId: string) => AgentSessionRecord | null
  /** `AgentSessionRecordStore.replacedRuntime`; absent where no runtime was replaced. */
  replacedRuntime?: (sessionId: string) => { fence: number } | undefined
  now: () => number
  /** Where a failing sink or observer is reported; neither may cost subscribers their event. */
  logger: StructuredAgentSessionLogger
  /** Every projection change, whether or not anyone is subscribed. `replay` marks a re-projection
   *  of state the host already knew (restore, an arriving subscriber) rather than a journal edge. */
  onStatusChanged?: (
    summary: AgentSessionStatusSummary,
    options: StructuredAgentSessionStatusObserverOptions
  ) => void
  /** Resolved on every call: the host builds this feed in a field initializer, before its own
   *  deps are assigned. The sink holds the session's child records; the summary reads them there. */
  statusSink?: () => StructuredAgentSessionStatusSink | undefined
  /** The session's child records changed, so every other reader of them republishes; `producer`
   *  is the write path of the child whose report changed them. */
  onChildWorkChanged?: (
    sessionId: string,
    producer?: StructuredAgentSessionChildWorkProducer
  ) => void
  /** The session's agent proved a start: its row's phase became `ready`. */
  onAgentStarted?: (sessionId: string) => void
}
