import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  deferredStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from './structured-agent-session-logger'
import {
  StructuredAgentSessionStatusFeed,
  type StructuredAgentSessionStatusFeedDeps,
  type StructuredAgentSessionStatusSink
} from './structured-agent-session-status-feed'
import {
  StructuredAgentSessionSubagentRows,
  type StructuredAgentSessionSubagentRowsDeps
} from './structured-agent-session-subagent-rows'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import type { StructuredAgentSessionConversationNaming } from './structured-agent-session-host-types'

/** Resolve deps lazily because field initializers run before host constructor assignments. */
export function createStructuredAgentSessionHostStatusFeed(args: {
  sessions: StructuredAgentSessionStatusFeedDeps['sessions']
  starting?: (sessionId: string) => boolean
  now: () => number
  currentWork: StructuredAgentSessionSubagentRowsDeps['currentWork']
  deps: () => {
    store: Pick<AgentSessionRecordStore, 'getRecord' | 'replacedRuntime'>
    logger: StructuredAgentSessionLogger
    onSessionStatusChanged?: StructuredAgentSessionStatusFeedDeps['onStatusChanged']
    statusSink?: StructuredAgentSessionStatusSink
    conversationNaming?: StructuredAgentSessionConversationNaming
  }
  onAgentStarted?: (sessionId: string) => void
  onChildWorkChanged?: (sessionId: string) => void
}): StructuredAgentSessionStatusFeed {
  const subagentRows = new StructuredAgentSessionSubagentRows({
    journal: (sessionId) => args.sessions.get(sessionId)?.journal,
    fence: (sessionId) => structuredAgentSessionConversationFence(args.deps().store, sessionId),
    currentWork: args.currentWork,
    readChildWork: (sessionId) => {
      const records = new Map(
        feed.readChildWorkRecords(sessionId)?.map((record) => [record.childWorkId, record])
      )
      return feed.readChildWork(sessionId)?.map((view) => {
        const { residency, outcomeBasis } = records.get(view.id) ?? {}
        return {
          ...view,
          ...(residency ? { residency } : {}),
          ...(outcomeBasis ? { outcomeBasis } : {})
        }
      })
    },
    onWriteFailed: (sessionId, error) =>
      args.deps().logger.warn('writing a subagent row failed', {
        scope: 'subagent-rows',
        sessionId,
        error
      })
  })
  const feed = new StructuredAgentSessionStatusFeed({
    sessions: args.sessions,
    starting: args.starting,
    getRecord: (sessionId) => args.deps().store.getRecord(sessionId),
    replacedRuntime: (sessionId) => args.deps().store.replacedRuntime(sessionId),
    now: args.now,
    logger: deferredStructuredAgentSessionLogger(() => args.deps().logger),
    onStatusChanged: (summary, options) => args.deps().onSessionStatusChanged?.(summary, options),
    statusSink: () => args.deps().statusSink,
    namingActiveSessionIds: () => args.deps().conversationNaming?.activeSessionIds() ?? [],
    namingFailure: (sessionId) => args.deps().conversationNaming?.failure(sessionId),
    ...(args.onAgentStarted ? { onAgentStarted: args.onAgentStarted } : {}),
    onChildWorkChanged: (sessionId, producer) => {
      subagentRows.changed(sessionId, producer)
      args.onChildWorkChanged?.(sessionId)
    }
  })
  return feed
}
