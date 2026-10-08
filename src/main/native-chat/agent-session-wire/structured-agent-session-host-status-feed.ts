import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  deferredStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from './structured-agent-session-logger'
import {
  StructuredAgentSessionStatusFeed,
  type StructuredAgentSessionStatusFeedDeps,
  type StructuredAgentSessionStatusSink
} from './structured-agent-session-status-feed'

/** Wire the host's own deps into a feed; keeps the host at one call site.
 *  `deps` is a thunk because the host builds the feed in a field initializer,
 *  before its constructor parameters are assigned. */
export function createStructuredAgentSessionHostStatusFeed(args: {
  sessions: StructuredAgentSessionStatusFeedDeps['sessions']
  now: () => number
  deps: () => {
    store: { getRecord: (sessionId: string) => AgentSessionRecord | null }
    logger: StructuredAgentSessionLogger
    onSessionStatusChanged?: StructuredAgentSessionStatusFeedDeps['onStatusChanged']
    statusSink?: StructuredAgentSessionStatusSink
  }
  onAgentStarted?: (sessionId: string) => void
  onChildWorkChanged?: (sessionId: string) => void
}): StructuredAgentSessionStatusFeed {
  return new StructuredAgentSessionStatusFeed({
    sessions: args.sessions,
    getRecord: (sessionId) => args.deps().store.getRecord(sessionId),
    now: args.now,
    logger: deferredStructuredAgentSessionLogger(() => args.deps().logger),
    onStatusChanged: (summary, options) => args.deps().onSessionStatusChanged?.(summary, options),
    // Resolved per call for the same reason the other deps are: the host builds this feed in a
    // field initializer, before its constructor parameters are assigned.
    statusSink: () => args.deps().statusSink,
    ...(args.onAgentStarted ? { onAgentStarted: args.onAgentStarted } : {}),
    ...(args.onChildWorkChanged ? { onChildWorkChanged: args.onChildWorkChanged } : {})
  })
}
