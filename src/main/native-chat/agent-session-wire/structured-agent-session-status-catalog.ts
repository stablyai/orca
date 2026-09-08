import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import {
  StructuredAgentSessionStatusFeed,
  type StructuredAgentSessionStatusFeedDeps
} from './structured-agent-session-status-feed'

export function createHostStatusFeed(
  deps: StructuredAgentSessionHostDeps,
  sessions: StructuredAgentSessionStatusFeedDeps['sessions'],
  now: () => number
): StructuredAgentSessionStatusFeed {
  // Legacy hydration writes visibility incrementally; only an already loaded index is complete.
  const complete =
    deps.store.getVisibleSessionTabIndex().present &&
    !deps.store.readOnly &&
    !deps.store.recoveredFromBackup
  return new StructuredAgentSessionStatusFeed({
    sessions,
    getRecord: (sessionId) => deps.store.getRecord(sessionId),
    now,
    catalog: () => ({ complete, sessionIds: deps.store.listVisibleSessionIds() }),
    isVisible: (sessionId) => deps.store.isSessionTabVisible(sessionId),
    onStatusChanged: (summary, options) => deps.onSessionStatusChanged?.(summary, options)
  })
}
