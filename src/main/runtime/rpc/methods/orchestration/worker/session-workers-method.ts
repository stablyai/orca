import { sessionWorkerBackgroundWait } from './session-worker-background-wait'
import { sessionWorkerState } from './session-worker-state'
import type {
  FleetDurableWorker,
  OrchestrationFleetWorker
} from '../../../../../../shared/orchestration/fleet/orchestration-fleet-projection'
import {
  ORCHESTRATION_SESSION_WORKER_SUMMARY_MAX,
  ORCHESTRATION_SESSION_WORKERS_LIMIT,
  ORCHESTRATION_SESSION_WORKERS_METHOD,
  type OrchestrationSessionWorker,
  type OrchestrationSessionWorkerActivity,
  type OrchestrationSessionWorkersResult
} from '../../../../../../shared/orchestration-session-workers'
import { workerTaskTitle } from '../../../../orchestration/workers/identity/worker-identity'
import { SessionWorkersParams } from '../../../../../../shared/rpc-contract/orchestration/orchestration-worker-release-schemas-params'
import { chatAssigneeSessionId } from '../../../../orchestration/workers/lifecycle/chat-assignee'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { FederatedDispatchRow } from '../../../../orchestration/db/orchestration-records'
import type { SessionPartyReader } from '../../../../orchestration/addressing/session-party-reader'
import { exposeUtcTimestamp } from '../../../../orchestration/db/utc-timestamp'
import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { resolveStructuredWorkerForDispatch } from '../structured-workers/orchestration-structured-worker-lifecycle'
import {
  ensureSessionWorkerRecords,
  inspectSessionWorker
} from './observation/session-worker-observation'
import { createSessionWorkerLivenessReader } from '../../../../orchestration/workers/lifecycle/session-worker-liveness'
import { isStructuredWorkerHandle } from '../../../../../../shared/orchestration/workers/structured-worker-handle'
import { projectWorkerFleet } from './fleet/worker-list-projection'
import { readCachedFederatedFleetSnapshots } from '../../../../orchestration/legacy-remote-home/federated-fleet-observation-cache'
import {
  applyFederatedFleetObservations,
  type FederatedFleetRuntime
} from '../../../../orchestration/legacy-remote-home/federated-fleet-snapshot'
import { structuredWorkerSession } from '../../../../orchestration/terminal-authority/structured-sessions/structured-worker-authority'
import { latestLiveAgentStatusRowsByPaneKey } from '../../../../../../shared/agent-status/live-agent-status-rows'
import {
  projectTerminalPresence,
  type TerminalPresenceCandidate,
  type TerminalPresenceReads
} from './session-worker-terminal-presence'
import type { AgentStatusIpcPayload } from '../../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { chatPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'

export const ORCHESTRATION_SESSION_WORKERS_METHODS = [
  defineOrchestrationMethod({
    name: ORCHESTRATION_SESSION_WORKERS_METHOD,
    access: { kind: 'reads', targets: { session: 'session' } },
    permission: 'workspace',
    params: SessionWorkersParams,
    handler: async (params, { runtime }): Promise<OrchestrationSessionWorkersResult> => ({
      workers: await readSessionWorkers(runtime, params.session, { lostTerminalsEnded: true }),
      workerNotices: true
    })
  })
]

export type SessionWorkersRuntime = Pick<
  OrcaRuntimeService,
  | 'getOrchestrationDb'
  | 'getOrchestrationFleetAgentStatusSnapshot'
  | 'ensureStructuredAgentSessionHost'
  | 'getAgentStatusSnapshotFn'
> &
  FederatedFleetRuntime &
  Partial<TerminalPresenceReads>

/** For surfaces that only show workers: an open terminal worker whose terminal its host can't find at all reads as
 *  `stopped`, as one that exited without reporting does. Its Dispatch stays open, so a coordinator's read leaves this off. */
export type DispatchWorkersReadOptions = { lostTerminalsEnded?: boolean }

/** The workers a chat started, newest first, as its execution host sees them; with `connectorOnly`,
 *  only those a turn its connector conversation woke started. */
export async function readSessionWorkers(
  runtime: SessionWorkersRuntime,
  session: string,
  options: { connectorOnly?: boolean } & DispatchWorkersReadOptions = {}
): Promise<OrchestrationSessionWorker[]> {
  const db = runtime.getOrchestrationDb()
  const ids = db.listDispatchIdsCreatedBySession(session, ORCHESTRATION_SESSION_WORKERS_LIMIT)
  return readDispatchWorkers(
    runtime,
    options.connectorOnly
      ? ids.filter((id) => db.getDispatchContextById(id)?.creator_turn_source === 'connector')
      : ids,
    options
  )
}

/** These Dispatches' workers, newest first, read in one pass over the worker records. */
export async function readDispatchWorkers(
  runtime: SessionWorkersRuntime,
  dispatchIds: readonly string[],
  options: DispatchWorkersReadOptions = {}
): Promise<OrchestrationSessionWorker[]> {
  const db = runtime.getOrchestrationDb()
  const rows =
    dispatchIds.length > 0 ? db.listWorkerTerminalResources({ dispatchIds: [...dispatchIds] }) : []
  if (rows.length === 0) {
    return []
  }
  const now = Date.now()
  const { fleet, chatStatusRows } = await projectDispatchFleet(
    runtime,
    rows,
    db.getWorkerAttentionFactsForDispatches(
      rows.map((row) => row.dispatchId),
      now
    ),
    now
  )
  const reads: { read: OrchestrationSessionWorker; candidate: TerminalPresenceCandidate }[] = []
  for (const worker of fleet.workers) {
    const durable = fleet.durable.get(worker.dispatchId)
    if (durable) {
      const observed = await withStructuredLiveness(runtime, db, worker, durable)
      reads.push({
        read: sessionWorker(db, observed, durable, chatStatusRows),
        candidate: { worker: observed, durable }
      })
    }
  }
  return options.lostTerminalsEnded
    ? projectTerminalPresence(runtime, reads)
    : reads.map(({ read }) => read)
}

/** The fleet projection of these rows: this machine's statuses, session records and paired hosts' verdicts. */
export async function projectDispatchFleet(
  runtime: SessionWorkersRuntime,
  rows: ReturnType<OrchestrationDb['listWorkerTerminalResources']>,
  attentionFacts: ReturnType<OrchestrationDb['getWorkerAttentionFactsForDispatches']>,
  now: number,
  read: {
    federatedRows?: readonly FederatedDispatchRow[]
    evidence?: DispatchFleetEvidence
    parties?: SessionPartyReader
  } = {}
) {
  const db = runtime.getOrchestrationDb()
  const { statuses, chatStatusRows } = read.evidence ?? readDispatchFleetEvidence(runtime)
  await ensureSessionWorkerRecords(runtime, rows)
  const fleet = projectWorkerFleet({
    rows,
    attentionFacts,
    statuses,
    limit: rows.length,
    now,
    completeProjection: true,
    observeSession: createSessionWorkerLivenessReader(db, statuses, undefined, read.parties)
  })
  // This machine's statuses cover only its own panes; a paired host's worker needs that host's verdict.
  const openIds = new Set(
    rows.flatMap((row) => (isOpenDispatch(row.dispatchStatus) ? [row.dispatchId] : []))
  )
  const federated = await readCachedFederatedFleetSnapshots({
    runtime,
    db,
    dispatchIds: rows.map((row) => row.dispatchId),
    isOpen: (dispatchId) => openIds.has(dispatchId),
    ...(read.federatedRows ? { federatedRows: read.federatedRows } : {})
  })
  if (federated) {
    applyFederatedFleetObservations(fleet, federated, fleet.durable)
  }
  return { fleet, chatStatusRows }
}

/** This machine's agent statuses, once for any number of projections. */
export type DispatchFleetEvidence = {
  statuses: ReturnType<SessionWorkersRuntime['getOrchestrationFleetAgentStatusSnapshot']>
  chatStatusRows: ReturnType<typeof latestLiveAgentStatusRowsByPaneKey>
}

export function readDispatchFleetEvidence(runtime: SessionWorkersRuntime): DispatchFleetEvidence {
  const rows = runtime.getAgentStatusSnapshotFn?.() ?? []
  return {
    statuses: runtime.getOrchestrationFleetAgentStatusSnapshot(undefined, rows),
    chatStatusRows: latestLiveAgentStatusRowsByPaneKey(rows)
  }
}

/** The worker asked its coordinator, or awaits its decision. */
export function hasPendingQuestion(worker: OrchestrationFleetWorker): boolean {
  return worker.attention.categories.some(
    (category) => category === 'input' || category === 'approval'
  )
}

function isOpenDispatch(status: string): boolean {
  return status === 'pending' || status === 'dispatched'
}

/** A chat worker publishes no agent-status row; read its session records, as worker-show does. */
export async function withStructuredLiveness(
  runtime: Parameters<typeof inspectSessionWorker>[0],
  db: OrchestrationDb,
  worker: OrchestrationFleetWorker,
  durable: FleetDurableWorker
): Promise<OrchestrationFleetWorker> {
  const handle = durable.agentTerminalHandle
  if (worker.liveness.verdict !== 'unverifiable' || !handle || !isStructuredWorkerHandle(handle)) {
    return worker
  }
  const observed = await inspectSessionWorker(runtime, db, worker.dispatchId, handle)
  if (observed?.status === 'live') {
    return {
      ...worker,
      liveness: { verdict: 'live', observedAt: Date.now(), source: 'execution_host' }
    }
  }
  if (observed?.status === 'exited') {
    return { ...worker, liveness: { verdict: 'exited', source: 'execution_host' } }
  }
  return worker
}

/** The agent the start asked for; a failed or restored start never published a provider. */
function requestedAgent(db: OrchestrationDb, dispatchId: string): string | null {
  const options = db.getWorkerDispatch(dispatchId)?.start_options
  try {
    const parsed: unknown = options ? JSON.parse(options) : null
    return typeof parsed === 'object' &&
      parsed !== null &&
      'agent' in parsed &&
      typeof parsed.agent === 'string'
      ? parsed.agent
      : null
  } catch {
    return null
  }
}

function sessionWorker(
  db: OrchestrationDb,
  worker: OrchestrationFleetWorker,
  durable: FleetDurableWorker,
  chatStatusRows: ReadonlyMap<string, AgentStatusIpcPayload>
): OrchestrationSessionWorker {
  const dispatch = db.getDispatchContextById(worker.dispatchId)
  const task = db.getTask(worker.taskId, worker.runId)
  const structured = resolveStructuredWorkerForDispatch(db, worker.dispatchId)
  const running = structured ? structuredWorkerSession(structured) : null
  const provider = running?.kind === 'here' ? running.record.provider : structured?.agent
  const state = sessionWorkerState(worker, durable)
  const settledAt =
    state === 'working' || state === 'unverifiable'
      ? null
      : (epochMs(dispatch?.completed_at ?? null) ?? null)
  const chatSessionId = structured?.sessionId ?? chatAssigneeSessionId(durable.agentTerminalHandle)
  return {
    dispatchId: worker.dispatchId,
    taskId: worker.taskId,
    runId: worker.runId,
    title: workerTaskTitle(task) ?? worker.taskId,
    agent: worker.provider?.id ?? provider ?? requestedAgent(db, worker.dispatchId),
    state,
    activity: sessionWorkerActivity(worker, chatSessionId, chatStatusRows),
    ...sessionWorkerBackgroundWait(worker, state, chatSessionId, chatStatusRows),
    pendingQuestion: hasPendingQuestion(worker),
    liveness: worker.liveness.verdict,
    host: worker.host.kind,
    ...(worker.host.kind === 'remote' ? { hostEnvironmentId: worker.host.id } : {}),
    worktreeId: durable.worktreeId ?? structured?.worktreeId ?? null,
    address: durable.agentTerminalHandle ?? null,
    paneKey: structured ? null : durable.paneKey,
    chatSessionId,
    summary: task?.result ? workerResultSummary(task.result) : null,
    startedAt: epochMs(dispatch?.dispatched_at ?? dispatch?.created_at ?? null) ?? Date.now(),
    settledAt
  }
}

/** A terminal worker's state comes with its fleet evidence; a chat worker binds no terminal, so its chat's row speaks. */
export function sessionWorkerActivity(
  worker: Pick<OrchestrationFleetWorker, 'stage' | 'liveness'>,
  chatSessionId: string | null,
  chatStatusRows: ReadonlyMap<string, Pick<AgentStatusIpcPayload, 'state'>>
): OrchestrationSessionWorkerActivity {
  if (worker.liveness.verdict !== 'live') {
    return 'unknown'
  }
  if (worker.stage.activity !== 'unknown' || !chatSessionId) {
    return worker.stage.activity
  }
  return chatStatusRows.get(chatPaneKey(chatSessionId))?.state ?? 'unknown'
}

/** A worker report is stored as JSON; its body (else its short subject) is the readable result. */
export function workerResultSummary(result: string): string | null {
  let text = result
  try {
    const parsed: unknown = JSON.parse(result)
    if (parsed && typeof parsed === 'object') {
      const subject = 'subject' in parsed ? parsed.subject : null
      const body = 'body' in parsed ? parsed.body : null
      text =
        typeof body === 'string' && body.trim() ? body : typeof subject === 'string' ? subject : ''
    }
  } catch {
    // A plain-text result is its own summary.
  }
  const clipped = text.trim().slice(0, ORCHESTRATION_SESSION_WORKER_SUMMARY_MAX)
  return clipped || null
}

function epochMs(timestamp: string | null): number | null {
  const parsed = timestamp ? Date.parse(exposeUtcTimestamp(timestamp) ?? timestamp) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}
