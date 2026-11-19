import type { FleetAgentStatusEvidence } from '../../../../../shared/orchestration/fleet/orchestration-fleet-agent-status-evidence'
import type { FleetSessionObservation } from '../../../../../shared/orchestration/fleet/orchestration-fleet-projection'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { isStructuredWorkerHandle } from '../../../../../shared/orchestration/workers/structured-worker-handle'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { DispatchContextRow } from '../../db/orchestration-records'
import {
  createLineageRunningSessionResolver,
  readAgentSessionRecordStore,
  type AgentSessionRecordReader
} from '../../addressing/session-lineage/structured-session-lineage'
import {
  observeStructuredWorker,
  resolveStructuredWorkerIdentity
} from '../../terminal-authority/structured-sessions/structured-worker-authority'
import { sessionIdFromStructuredWorkerIncarnation } from '../../terminal-authority/structured-sessions/structured-worker-identity'
import { chatAssigneeSessionId, observeChatAssignee } from './chat-assignee'

export type SessionWorkerSubject = {
  agentTerminalHandle: string | null
  resource?: { processIncarnation?: string | null; paneKey?: string | null } | null
}

/** Agent-slept terminal workers read as live and idle; their pane's kept status row is their activity. */
export function withSleptAgentWorkers(
  observe: (worker: SessionWorkerSubject) => FleetSessionObservation | undefined,
  statuses: readonly FleetAgentStatusEvidence[],
  sleptAgentHandle: (paneKey: string) => string | null
): (worker: SessionWorkerSubject) => FleetSessionObservation | undefined {
  let byPane: Map<string, FleetAgentStatusEvidence> | null = null
  return (worker) => {
    const observed = observe(worker)
    const paneKey = worker.resource?.paneKey
    // Only the worker's own handle: another conversation slept in its old pane is not this worker.
    if (
      observed ||
      !paneKey ||
      !worker.agentTerminalHandle ||
      sleptAgentHandle(paneKey) !== worker.agentTerminalHandle
    ) {
      return observed
    }
    if (!byPane) {
      byPane = new Map()
      for (const status of statuses) {
        const key = status.activity.paneKey
        if (key && !byPane.has(key)) {
          byPane.set(key, status)
        }
      }
    }
    const activity = byPane.get(paneKey)
    return activity ? { status: 'live', activity } : { status: 'live' }
  }
}

/** Chat-mode workers' liveness for every fleet surface, from in-memory session records; undefined selects the terminal path. */
export function createSessionWorkerLivenessReader(
  db: OrchestrationDb | null | undefined,
  statuses: readonly FleetAgentStatusEvidence[],
  records: AgentSessionRecordReader | null = readAgentSessionRecordStore()
): (worker: SessionWorkerSubject) => FleetSessionObservation | undefined {
  const resolveSession = createLineageRunningSessionResolver(records)
  let statusByPane: Map<string, FleetAgentStatusEvidence> | undefined
  // A session's status row lives at its derived pane key, not the worker's minted one.
  const activityFor = (sessionId: string) => {
    statusByPane ??= new Map(statuses.map((status) => [status.activity.paneKey, status]))
    return statusByPane.get(
      structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
    )
  }
  const live = (sessionId: string): FleetSessionObservation => {
    const activity = activityFor(sessionId)
    return activity ? { status: 'live', activity } : { status: 'live' }
  }
  return (worker) => {
    const handle = worker.agentTerminalHandle
    const chat = chatAssigneeSessionId(handle)
    if (chat) {
      const observed = observeChatAssignee(chat, db, records)
      return observed.status === 'live'
        ? live(observed.session.sessionId)
        : observed.status === 'exited'
          ? { status: 'exited' }
          : { status: 'unverifiable', detail: observed.reason }
    }
    if (!isStructuredWorkerHandle(handle)) {
      return undefined
    }
    const sessionId =
      sessionIdFromStructuredWorkerIncarnation(worker.resource?.processIncarnation) ??
      resolveStructuredWorkerIdentity(handle, db)?.sessionId
    if (!sessionId) {
      return { status: 'unverifiable', detail: 'No session record names this structured worker.' }
    }
    const observed = observeStructuredWorker({ sessionId }, { resolveSession })
    const running = resolveSession(sessionId)
    return observed.status === 'live'
      ? live(running.kind === 'here' ? running.sessionId : sessionId)
      : observed.status === 'exited'
        ? { status: 'exited' }
        : { status: 'unverifiable', detail: observed.reason ?? 'The session cannot be verified.' }
  }
}

export type DispatchSessionObserver = (
  dispatch: Pick<DispatchContextRow, 'id' | 'assignee_handle' | 'process_incarnation'>
) => FleetSessionObservation | undefined

/** Structured workers' verdicts for per-pane attention, once per Dispatch so the batched pass reads the same one. */
export function createDispatchSessionLivenessReader(
  ...args: Parameters<typeof createSessionWorkerLivenessReader>
): {
  observe: DispatchSessionObserver
  observed: (dispatchId: string) => FleetSessionObservation | undefined
} {
  const read = createSessionWorkerLivenessReader(...args)
  const byDispatch = new Map<string, FleetSessionObservation | undefined>()
  return {
    observe: (dispatch) => {
      // A chat's reach check queries SQLite; this runs per publication, so chats keep their status row here.
      if (!isStructuredWorkerHandle(dispatch.assignee_handle)) {
        return undefined
      }
      if (!byDispatch.has(dispatch.id)) {
        byDispatch.set(
          dispatch.id,
          read({
            agentTerminalHandle: dispatch.assignee_handle,
            resource: { processIncarnation: dispatch.process_incarnation }
          })
        )
      }
      return byDispatch.get(dispatch.id)
    },
    observed: (dispatchId) => byDispatch.get(dispatchId)
  }
}
