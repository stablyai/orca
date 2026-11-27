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
import {
  sessionIdFromStructuredWorkerIncarnation,
  structuredWorkerIdentities,
  structuredWorkerIdentityFromRow
} from '../../terminal-authority/structured-sessions/structured-worker-identity'
import { structuredWorkerOwned } from '../../terminal-authority/structured-sessions/structured-worker-custody'
import { chatAssigneeSessionId, observeChatAssignee } from './chat-assignee'

export type SessionWorkerSubject = {
  agentTerminalHandle: string | null
  resource?: {
    processIncarnation?: string | null
    paneKey?: string | null
    worktreeId?: string | null
    hostScope?: string | null
  } | null
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
  options: { parties?: SessionPartyReader | null; includeResumeGuidance?: true } = {}
): (worker: SessionWorkerSubject) => FleetSessionObservation | undefined {
  // A chat assignee's party, from the database unless a caller read its rows already.
  const { parties = db } = options
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
    if (observed.status === 'exited') {
      if (
        options.includeResumeGuidance &&
        running.kind === 'here' &&
        running.record.ownerObservation.deathEvidence?.resumeByMail === true &&
        structuredWorkerOwned(running)
      ) {
        const resource = worker.resource
        const identity =
          structuredWorkerIdentities.get(handle) ??
          (resource &&
            structuredWorkerIdentityFromRow({
              terminal_handle: handle,
              pane_key: resource.paneKey ?? null,
              process_incarnation: resource.processIncarnation ?? null,
              worktree_id: resource.worktreeId ?? null,
              host_scope: resource.hostScope ?? null
            }))
        if (identity?.sessionId === sessionId) {
          return { status: 'exited', canResume: true }
        }
      }
      return { status: 'exited' }
    }
    return observed.status === 'live'
      ? live(running.kind === 'here' ? running.sessionId : sessionId)
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
