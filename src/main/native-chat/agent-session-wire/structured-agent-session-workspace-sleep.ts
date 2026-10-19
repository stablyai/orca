import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type { AgentSessionWorkspaceSleepResult } from '../../../shared/agent-session-workspace-sleep'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import type { StructuredAgentSessionConversationLifetime } from './structured-agent-session-conversation-lifetime'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'

type WorkspaceSleepHost = {
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'logger' | 'hasOpenDispatch'>
  tasks: StructuredAgentSessionTaskQueue
  lifetime: Pick<StructuredAgentSessionConversationLifetime, 'closeForWorkspaceSleep'>
  sessions: StructuredAgentSessionConversations
  deliveryRunning: (sessionId: string) => boolean
  childWorkIncomplete: (sessionId: string) => boolean
}

/** Snapshot host-owned members and return only same-call, current positive stop receipts. */
export async function sleepStructuredAgentSessionWorkspace(
  host: WorkspaceSleepHost,
  workspaceId: string
): Promise<AgentSessionWorkspaceSleepResult> {
  let records: ReturnType<StructuredAgentSessionHostDeps['store']['listRecords']>
  try {
    records = host.deps.store.listRecords()
  } catch (error) {
    host.deps.logger.warn('workspace chat inventory failed', {
      scope: 'workspace-chat-inventory',
      workspaceId,
      error
    })
    return { stoppedSessionIds: [], failures: [{ reason: 'inventory-unavailable' }] }
  }
  const belongs = (location: AgentSessionExecutionLocation): boolean =>
    location.workspaceId === workspaceId && location.executionHostId === LOCAL_EXECUTION_HOST_ID
  const candidates = new Set([
    ...records.filter((record) => belongs(record.location)).map((record) => record.sessionId),
    ...host.tasks.pendingMembers(workspaceId, LOCAL_EXECUTION_HOST_ID)
  ])
  const sessionIds = [...candidates]
  // Admits every close synchronously; `async` turns a synchronous throw into a rejection.
  const stops = await Promise.allSettled(
    sessionIds.map(async (sessionId) =>
      host.lifetime.closeForWorkspaceSleep(sessionId, workspaceId, LOCAL_EXECUTION_HOST_ID)
    )
  )
  const stoppedSessionIds: string[] = []
  const failures: NonNullable<AgentSessionWorkspaceSleepResult['failures']> = []
  for (const [index, stop] of stops.entries()) {
    const sessionId = sessionIds[index]
    if (stop.status === 'rejected') {
      failures.push({ sessionId, reason: 'stop-unverifiable' })
      continue
    }
    if (!stop.value) {
      continue
    }
    try {
      const record = host.deps.store.getRecord(sessionId)
      if (!record || !belongs(record.location) || record.lease.runtimeFence !== stop.value.fence) {
        continue
      }
      if (!stop.value.stopped) {
        failures.push({ sessionId, reason: 'stop-unverifiable' })
        continue
      }
      // Judge later work by facts, not lane occupancy: the stop queues its own end report.
      const session = host.sessions.get(sessionId)
      if (
        session?.child ||
        host.tasks.hasPendingAttach(sessionId) ||
        host.deliveryRunning(sessionId) ||
        host.childWorkIncomplete(sessionId) ||
        session?.journal.pendingSubmissions().length ||
        host.deps.hasOpenDispatch?.(record)
      ) {
        continue
      }
      stoppedSessionIds.push(sessionId)
    } catch (error) {
      host.deps.logger.warn('workspace chat stop receipt could not be checked', {
        scope: 'workspace-chat-receipt',
        sessionId,
        error
      })
      failures.push({ sessionId, reason: 'stop-unverifiable' })
    }
  }
  return failures.length > 0 ? { stoppedSessionIds, failures } : { stoppedSessionIds }
}
