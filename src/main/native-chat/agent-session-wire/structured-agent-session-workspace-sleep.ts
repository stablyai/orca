import type {
  AgentSessionExecutionLocation,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import type { AgentSessionWorkspaceSleepResult } from '../../../shared/agent-session-workspace-sleep'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import type { StructuredAgentSessionConversationLifetime } from './structured-agent-session-conversation-lifetime'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'

type WorkspaceSleepHost = {
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'logger' | 'hasOpenDispatch' | 'now'>
  tasks: StructuredAgentSessionTaskQueue
  lifetime: Pick<StructuredAgentSessionConversationLifetime, 'closeForWorkspaceSleep'>
  sessions: StructuredAgentSessionConversations
  deliveryRunning: (sessionId: string) => boolean
  childWorkIncomplete: (sessionId: string) => boolean
  publishRecordNotes: (sessionId: string) => void
}

type WorkspaceSleepVerdict = { stopped: true } | { stopped: false; fence: number } | null

/** Return only this call’s current proven stops; markAsleep marks exactly those receipts. */
export async function sleepStructuredAgentSessionWorkspace(
  host: WorkspaceSleepHost,
  workspaceId: string,
  markAsleep = false
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
  // async converts synchronous close failures to rejections while admitting every close immediately.
  const stops = await Promise.allSettled(
    sessionIds.map(async (sessionId) => {
      const stop = await host.lifetime.closeForWorkspaceSleep(
        sessionId,
        workspaceId,
        LOCAL_EXECUTION_HOST_ID
      )
      return host.tasks.serialize(sessionId, async () => {
        const record = host.deps.store.getRecord(sessionId)
        if (
          !stop ||
          !record ||
          !belongs(record.location) ||
          record.lease.runtimeFence !== stop.fence ||
          host.deps.store.admittedSendCount(sessionId) !== stop.admittedSends
        ) {
          return null
        }
        return settleWorkspaceSleepChat(host, sessionId, stop.stopped, markAsleep)
      })
    })
  )
  const stoppedSessionIds: string[] = []
  const failures: NonNullable<AgentSessionWorkspaceSleepResult['failures']> = []
  for (const [index, stop] of stops.entries()) {
    const sessionId = sessionIds[index]
    if (stop.status === 'rejected') {
      host.deps.logger.warn('workspace chat stop receipt could not be decided', {
        scope: 'workspace-chat-receipt',
        sessionId,
        error: stop.reason
      })
      failures.push({ sessionId, reason: 'stop-unverifiable' })
    } else if (stop.value?.stopped) {
      stoppedSessionIds.push(sessionId)
    } else if (
      stop.value &&
      host.deps.store.getRecord(sessionId)?.lease.runtimeFence === stop.value.fence
    ) {
      failures.push({ sessionId, reason: 'stop-unverifiable' })
    }
  }
  return failures.length > 0 ? { stoppedSessionIds, failures } : { stoppedSessionIds }
}

async function settleWorkspaceSleepChat(
  host: WorkspaceSleepHost,
  sessionId: string,
  stopped: boolean,
  markAsleep: boolean
): Promise<WorkspaceSleepVerdict> {
  const current = host.deps.store.getRecord(sessionId)
  if (!current) {
    return null
  }
  if (!stopped) {
    return { stopped: false, fence: current.lease.runtimeFence }
  }
  // Stop queues its own end report, so judge work by state rather than lane occupancy.
  const quiet = (record: AgentSessionRecord): boolean => {
    const session = host.sessions.get(sessionId)
    return !(
      session?.child ||
      host.tasks.hasPendingAttach(sessionId) ||
      host.deliveryRunning(sessionId) ||
      host.childWorkIncomplete(sessionId) ||
      session?.journal.pendingSubmissions().length ||
      host.deps.hasOpenDispatch?.(record)
    )
  }
  if (!markAsleep) {
    return quiet(current) ? { stopped: true } : null
  }
  let marked = false
  const now = host.deps.now?.() ?? Date.now()
  // Check inside the write so the mark and receipt cannot disagree.
  await host.deps.store.transitionHandoff(sessionId, (record) => {
    marked = quiet(record)
    return marked ? { ...record, sleptAt: now, updatedAt: now } : record
  })
  if (marked) {
    host.publishRecordNotes(sessionId)
  }
  return marked ? { stopped: true } : null
}
