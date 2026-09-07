import type { RuntimeTerminalInteractiveWait } from '../../../../../../shared/runtime-types'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { parseWorkerTerminalHostScope } from '../../../../orchestration/worker-terminal-process-liveness'
import type { OrchestrationFleetWorker } from '../../../../../../shared/orchestration-fleet-projection'
import { projectWorkerFleet } from './worker-list-projection'
import type {
  DispatchContextRow,
  FederatedDispatchRow,
  WorkerDispatchRow
} from '../../../../orchestration/types'

export async function inspectWorkerTerminal(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string
): Promise<{
  terminal: Awaited<ReturnType<OrcaRuntimeService['showTerminal']>> | null
  exact: boolean
  status: 'unattached' | 'missing' | 'identity_changed' | 'live' | 'exited' | 'unverifiable'
  /** Set with `unverifiable`; names what we lost contact with. */
  reason?: string
  /** Set only on a proven-exact worker parked on a prompt that needs a human. */
  agentWait?: RuntimeTerminalInteractiveWait | null
}> {
  const worker = db.getWorkerDispatch(dispatchId)
  const terminalHandle =
    worker?.agent_terminal_handle ?? db.getDispatchContextById(dispatchId)?.assignee_handle
  if (!terminalHandle) {
    return { terminal: null, exact: false, status: 'unattached' }
  }
  const terminal = await runtime.showTerminal(terminalHandle).catch(() => null)
  if (!terminal) {
    return { terminal: null, exact: false, status: 'missing' }
  }
  const exact = db.isDispatchProcessCurrent({
    dispatchId,
    paneKey: runtime.getTerminalPaneKey(terminalHandle),
    processIncarnation: runtime.getTerminalProcessIncarnation(terminalHandle)
  })
  if (!exact) {
    return { terminal, exact, status: 'identity_changed' }
  }
  // Why: the aggregate inventory only iterates registered providers, so a dropped
  // relay clears `connected` for every remote PTY at once. Lost contact is not a
  // death certificate, and the verdict is the only field that can tell them apart.
  // Why reused rather than re-derived: showTerminal already scanned this pane's retained
  // tail for the same verdict, and a second scan could also disagree with the one it published.
  // Exact-gated by the early return above: a replaced process's prompt would attribute another
  // lane's blocker to this worker.
  const agentWait = terminal.agentWait
  const verdict = runtime.getTerminalLivenessVerdict?.(terminalHandle) ?? null
  if (verdict?.status === 'unverifiable') {
    return { terminal, exact, status: 'unverifiable', reason: verdict.reason, agentWait }
  }
  if (verdict?.status === 'live') {
    return { terminal, exact, status: 'live', agentWait }
  }
  if (!verdict) {
    const dispatch = db.getDispatchContextById?.(dispatchId)
    const persistedHostScope = parseWorkerTerminalHostScope(dispatch?.host_scope ?? null)
    const currentHostScope = runtime.getOrchestrationDispatchAuthority?.(terminalHandle)?.hostScope
    if (persistedHostScope?.kind === 'ssh' || currentHostScope?.kind === 'ssh') {
      return {
        terminal,
        exact,
        status: 'unverifiable',
        reason: 'missing_liveness_verdict',
        agentWait
      }
    }
    return {
      terminal,
      exact,
      status: terminal.connected === false ? 'exited' : 'live',
      agentWait
    }
  }
  return {
    terminal,
    exact,
    status: 'exited',
    agentWait
  }
}

/** Why conditional: a present `agentWait: null` must mean "looked, nothing waiting"; an
 *  unattached, missing or identity-changed worker was never looked at, and a bare
 *  `unverifiable` is not actionable without naming what contact was lost. */
export function exposeObservation(observation: Awaited<ReturnType<typeof inspectWorkerTerminal>>) {
  return {
    status: observation.status,
    exactWorker: observation.exact,
    ...(observation.reason ? { reason: observation.reason } : {}),
    ...(observation.agentWait !== undefined ? { agentWait: observation.agentWait } : {})
  }
}

function exposeContextOnlyWorker(dispatch: DispatchContextRow) {
  return {
    dispatchId: dispatch.id,
    runtimeEpoch: null,
    state: 'unsupervised' as const,
    stage: dispatch.capability_hash ? 'injected' : 'context_only',
    worktreeId: null,
    agentTerminalHandle: dispatch.assignee_handle,
    setupState: 'not_applicable',
    effects: [] as unknown[],
    residualResources: [] as unknown[],
    startOptions: {} as unknown,
    lastError: dispatch.last_failure,
    createdAt: dispatch.created_at,
    updatedAt: dispatch.completed_at ?? dispatch.created_at
  }
}

// Why: `launch_token_hash` and `capability_hash` are authority material with no receipt
// consumer, and `host_scope` shipped as a JSON string inside JSON. One camelCase shape,
// the same one `exposeWorker` publishes beside it.
export function exposeDispatchContext(dispatch: DispatchContextRow) {
  return {
    id: dispatch.id,
    runId: dispatch.run_id,
    taskId: dispatch.task_id,
    // Every shipped CLI prints `dispatch.task_id`, and mixed client/host versions are the
    // normal state, so the rename ships beside the spelling old clients still read.
    task_id: dispatch.task_id,
    contractVersion: dispatch.contract_version,
    assigneeHandle: dispatch.assignee_handle,
    assigneePaneKey: dispatch.assignee_pane_key,
    processIncarnation: dispatch.process_incarnation,
    capabilityRevokedAt: dispatch.capability_revoked_at,
    retryOfDispatchId: dispatch.retry_of_dispatch_id,
    creatorDispatchId: dispatch.creator_dispatch_id,
    hostScope: parseWorkerTerminalHostScope(dispatch.host_scope),
    status: dispatch.status,
    failureCount: dispatch.failure_count,
    lastFailure: dispatch.last_failure,
    terminationReason: dispatch.termination_reason,
    depth: dispatch.depth,
    dispatchedAt: dispatch.dispatched_at,
    completedAt: dispatch.completed_at,
    createdAt: dispatch.created_at,
    lastHeartbeatAt: dispatch.last_heartbeat_at
  }
}

export async function showContextOnlyWorker(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatch: DispatchContextRow
) {
  const observation = await inspectWorkerTerminal(runtime, db, dispatch.id)
  return {
    dispatch: exposeDispatchContext(dispatch),
    worker: exposeContextOnlyWorker(dispatch),
    projection: projectFleetWorker(runtime, db, dispatch.id),
    terminal: observation.exact ? observation.terminal : null,
    observation: exposeObservation(observation),
    terminalResource: null
  }
}

// Why: the row was spread verbatim beside its parsed copies, so a reader got
// `residual_resources` (a JSON string) next to `residualResources` (an array) and had to
// guess which was authoritative. Parse once, emit camelCase once.
export function exposeWorker(worker: WorkerDispatchRow) {
  return {
    dispatchId: worker.dispatch_id,
    runtimeEpoch: worker.runtime_epoch,
    state: worker.state,
    stage: worker.stage,
    worktreeId: worker.worktree_id,
    agentTerminalHandle: worker.agent_terminal_handle,
    setupState: worker.setup_state,
    effects: JSON.parse(worker.effects) as unknown[],
    residualResources: JSON.parse(worker.residual_resources) as unknown[],
    startOptions: JSON.parse(worker.start_options) as unknown,
    lastError: worker.last_error,
    createdAt: worker.created_at,
    updatedAt: worker.updated_at
  }
}

/**
 * The same fleet verdict `worker-list` publishes, for one Dispatch.
 *
 * Why worker-show needs it: `observation.status` is PTY liveness, so an agent that died
 * at a trust prompt inside a live pane read `live` here and `unverifiable` from
 * `worker-list` — and `worker-list`'s own `nextAction` pointed back at this command.
 */
export function projectFleetWorkerPage(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string
): ReturnType<typeof projectWorkerFleet> | null {
  const rows = db.listWorkerTerminalResources({ dispatchIds: [dispatchId], limit: 1 })
  if (rows.length === 0) {
    return null
  }
  const now = Date.now()
  return projectWorkerFleet({
    rows,
    attentionFacts: db.getWorkerAttentionFactsForDispatches([dispatchId], now),
    statuses: runtime.getOrchestrationFleetAgentStatusSnapshot(),
    limit: 1,
    now
  })
}

export function projectFleetWorker(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string
): OrchestrationFleetWorker | null {
  return projectFleetWorkerPage(runtime, db, dispatchId)?.workers[0] ?? null
}

export function exposeFederatedWorkerObservation(
  observation: { status?: string; exactWorker: boolean; reason?: string },
  projected: boolean
) {
  if (!projected) {
    return { status: 'unverifiable' as const, exactWorker: false, reason: 'observation_superseded' }
  }
  // Legacy `running` maps to live; an absent peer verdict remains unverifiable.
  return {
    ...observation,
    status: observation.status === 'running' ? 'live' : (observation.status ?? 'unverifiable')
  }
}

export function resolvePinnedFederatedServer(
  runtime: OrcaRuntimeService,
  federated: FederatedDispatchRow
) {
  const server = runtime.resolveOrchestrationWorkerServer(federated.environment_id)
  if (server.peerFingerprint !== federated.peer_fingerprint) {
    throw new OrchestrationError(
      'peer_changed',
      `Saved environment ${federated.environment_name} now identifies a different Orca server.`
    )
  }
  return server
}

export async function callFederatedWorkerShow(
  runtime: OrcaRuntimeService,
  federated: FederatedDispatchRow
): Promise<{
  runtimeEpoch: string
  attachment: {
    state: string
    stage: string
    last_error: string | null
    worktree_id: string | null
    terminal_handle: string | null
    setup_state: string
    effects: unknown[]
    residualResources: unknown[]
  }
  terminal: unknown
  observation: {
    status: string
    exactWorker: boolean
    reason?: string
    /** Absent from servers that predate the field; absence is unknown, not "not waiting". */
    agentWait?: RuntimeTerminalInteractiveWait | null
  }
}> {
  const server = resolvePinnedFederatedServer(runtime, federated)
  return (await runtime.callOrchestrationWorkerServer(
    server.environmentId,
    'orchestration.federationShow',
    { dispatchId: federated.dispatch_id },
    15_000,
    undefined,
    { expectedEnvironmentPairingRevision: server.pairingRevision }
  )) as Awaited<ReturnType<typeof callFederatedWorkerShow>>
}
