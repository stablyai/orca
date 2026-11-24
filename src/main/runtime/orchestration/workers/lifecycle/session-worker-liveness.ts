import type { SessionPartyReader } from '../../addressing/session-party-reader'
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
  resource?: { processIncarnation?: string | null } | null
}

/** The session a structured worker was minted for, known before (and without) verifying it. */
export function structuredWorkerSessionIdOf(
  worker: SessionWorkerSubject,
  db: OrchestrationDb | null | undefined
): string | null {
  const handle = worker.agentTerminalHandle
  if (!isStructuredWorkerHandle(handle)) {
    return null
  }
  return (
    sessionIdFromStructuredWorkerIncarnation(worker.resource?.processIncarnation) ??
    resolveStructuredWorkerIdentity(handle, db)?.sessionId ??
    null
  )
}

/** Chat-mode workers' liveness for every fleet surface, from in-memory session records; undefined selects the terminal path. */
export function createSessionWorkerLivenessReader(
  db: OrchestrationDb | null | undefined,
  /** Every status, or a reader of one pane's, so a caller with few workers reads only their panes. */
  statuses:
    | readonly FleetAgentStatusEvidence[]
    | ((paneKey: string) => FleetAgentStatusEvidence | undefined),
  records: AgentSessionRecordReader | null = readAgentSessionRecordStore(),
  // A chat assignee's party, from the database unless a caller read its rows already.
  parties: SessionPartyReader | null | undefined = db
): (worker: SessionWorkerSubject) => FleetSessionObservation | undefined {
  const resolveSession = createLineageRunningSessionResolver(records)
  let statusByPane: Map<string, FleetAgentStatusEvidence> | undefined
  // A session's status row lives at its derived pane key, not the worker's minted one.
  const activityFor = (sessionId: string) => {
    const paneKey = structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
    if (typeof statuses === 'function') {
      return statuses(paneKey)
    }
    statusByPane ??= new Map(statuses.map((status) => [status.activity.paneKey, status]))
    return statusByPane.get(paneKey)
  }
  const live = (sessionId: string): FleetSessionObservation => {
    const activity = activityFor(sessionId)
    return activity ? { status: 'live', activity } : { status: 'live' }
  }
  return (worker) => {
    const handle = worker.agentTerminalHandle
    const chat = chatAssigneeSessionId(handle)
    if (chat) {
      const observed = observeChatAssignee(chat, parties, records)
      return observed.status === 'live'
        ? live(observed.session.sessionId)
        : observed.status === 'exited'
          ? { status: 'exited' }
          : { status: 'unverifiable', detail: observed.reason }
    }
    if (!isStructuredWorkerHandle(handle)) {
      return undefined
    }
    const sessionId = structuredWorkerSessionIdOf(worker, db)
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
