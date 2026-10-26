import type { RuntimeTerminalInteractiveWait } from '../../../../../../shared/runtime-types'
import type { WorkerTerminalReleaseRuntime } from '../../../../orchestration/worker-terminal-release-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { parseWorkerTerminalHostScope } from '../../../../../../shared/worker-terminal-host-scope'
import type { OrchestrationFleetWorker } from '../../../../../../shared/orchestration-fleet-projection'
import { projectWorkerFleet } from './worker-list-projection'
import { observeChatAssignee } from '../../../../orchestration/chat-assignee'
import { inspectSessionWorker } from './session-worker-observation'
import type {
  DispatchContextRow,
  FederatedDispatchRow,
  WorkerDispatchRow
} from '../../../../orchestration/types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'

/** Recover live handles by recorded process incarnation so stale durable handles cannot hide and leak running workers. */
export async function inspectWorkerTerminal(
  runtime: WorkerTerminalReleaseRuntime,
  db: OrchestrationDb,
  dispatchId: string
): Promise<{
  terminal: Awaited<ReturnType<WorkerTerminalReleaseRuntime['showTerminal']>> | null
  exact: boolean
  status: 'unattached' | 'missing' | 'identity_changed' | 'live' | 'exited' | 'unverifiable'
  /** Set with `unverifiable`; names what we lost contact with. */
  reason?: string
  /** Set only on a proven-exact worker parked on a prompt that needs a human. */
  agentWait?: RuntimeTerminalInteractiveWait | null
  /** Structured workers: mail reachability includes at-rest sessions that mail restarts; absent means ownership unreadable. status remains the process verdict. */
  addressable?: boolean
  /** The durable or incarnation-reminted live handle; null means none resolved. */
  terminalHandle: string | null
}> {
  const worker = db.getWorkerDispatch(dispatchId)
  const terminalHandle =
    worker?.agent_terminal_handle ?? db.getDispatchContextById(dispatchId)?.assignee_handle
  if (!terminalHandle) {
    return { terminal: null, exact: false, status: 'unattached', terminalHandle: null }
  }
  const session = await inspectSessionWorker(runtime, db, dispatchId, terminalHandle)
  if (session) {
    return session
  }
  let effectiveHandle = terminalHandle
  let terminal = await runtime.showTerminal(effectiveHandle).catch(() => null)
  if (!terminal) {
    // Remint by exact incarnation after durable-handle loss so show/release reach the live process; workerList never performs this inspection.
    const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
    const reminted = resource?.process_incarnation
      ? runtime.resolveTerminalHandleByProcessIncarnation(
          resource.process_incarnation,
          resource.host_scope
        )
      : null
    if (reminted) {
      const remintedTerminal = await runtime.showTerminal(reminted).catch(() => null)
      if (remintedTerminal) {
        effectiveHandle = reminted
        terminal = remintedTerminal
      }
    }
  }
  if (!terminal) {
    // The re-mint above failed, so no live handle resolved; report the durable handle unresolved.
    return { terminal: null, exact: false, status: 'missing', terminalHandle: null }
  }
  const exact = db.isDispatchProcessCurrent({
    dispatchId,
    paneKey: runtime.getTerminalPaneKey(effectiveHandle),
    processIncarnation: runtime.getTerminalProcessIncarnation(effectiveHandle)
  })
  if (!exact) {
    return { terminal, exact, status: 'identity_changed', terminalHandle: effectiveHandle }
  }
  // Dropped relays clear connected without proving death; reuse showTerminal's host verdict and prompt scan.
  // Exact identity is required so another process's prompt cannot become this worker's blocker.
  const agentWait = terminal.agentWait
  const verdict = runtime.getTerminalLivenessVerdict?.(effectiveHandle) ?? null
  if (verdict?.status === 'unverifiable') {
    return {
      terminal,
      exact,
      status: 'unverifiable',
      reason: verdict.reason,
      agentWait,
      terminalHandle: effectiveHandle
    }
  }
  if (verdict?.status === 'live') {
    return { terminal, exact, status: 'live', agentWait, terminalHandle: effectiveHandle }
  }
  if (!verdict) {
    const dispatch = db.getDispatchContextById?.(dispatchId)
    const persistedHostScope = parseWorkerTerminalHostScope(dispatch?.host_scope ?? null)
    const currentHostScope = runtime.getOrchestrationDispatchAuthority?.(effectiveHandle)?.hostScope
    if (persistedHostScope?.kind === 'ssh' || currentHostScope?.kind === 'ssh') {
      return {
        terminal,
        exact,
        status: 'unverifiable',
        reason: 'missing_liveness_verdict',
        agentWait,
        terminalHandle: effectiveHandle
      }
    }
    // Switch point: main's rows carry the host's verdict; `connected` alone is the old word.
    if (ORCA_LAYOUT_OWNER_IS_MAIN && terminal.verdict === 'unverifiable') {
      return {
        terminal,
        exact,
        status: 'unverifiable',
        reason: 'missing_liveness_verdict',
        agentWait,
        terminalHandle: effectiveHandle
      }
    }
    return {
      terminal,
      exact,
      status:
        ORCA_LAYOUT_OWNER_IS_MAIN && terminal.verdict
          ? terminal.verdict
          : terminal.connected === false
            ? 'exited'
            : 'live',
      agentWait,
      terminalHandle: effectiveHandle
    }
  }
  return {
    terminal,
    exact,
    status: 'exited',
    agentWait,
    terminalHandle: effectiveHandle
  }
}

/** Emit agentWait:null only after checking the exact worker; absence means unknown. Name lost contact when liveness is unverifiable. */
export function exposeObservation(observation: Awaited<ReturnType<typeof inspectWorkerTerminal>>) {
  return {
    status: observation.status,
    exactWorker: observation.exact,
    ...(observation.reason ? { reason: observation.reason } : {}),
    ...(observation.agentWait !== undefined ? { agentWait: observation.agentWait } : {}),
    ...(observation.addressable !== undefined ? { addressable: observation.addressable } : {})
  }
}

function exposeContextOnlyWorker(dispatch: DispatchContextRow) {
  return {
    dispatchId: dispatch.id,
    runtimeEpoch: null,
    state: 'unsupervised' as const,
    // Without a worker row only context is supervised; inject paste has no durable record.
    stage: 'context_only',
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

// Hide authority hashes and decode host_scope; emit one camelCase shape matching exposeWorker.
export function exposeDispatchContext(dispatch: DispatchContextRow) {
  return {
    id: dispatch.id,
    runId: dispatch.run_id,
    taskId: dispatch.task_id,
    // Keep dispatch.task_id beside the rename because shipped CLIs still read it.
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
  runtime: WorkerTerminalReleaseRuntime,
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

// Decode residual_resources once and emit only residualResources; competing raw/parsed forms obscure authority.
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

/** Use the same agent verdict as worker-list: a live PTY does not prove its agent is live, especially when list recovery points to show. */
export function projectFleetWorkerPage(
  runtime: WorkerTerminalReleaseRuntime,
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
    now,
    observeChat: (sessionId) => observeChatAssignee(sessionId, db)
  })
}

export function projectFleetWorker(
  runtime: WorkerTerminalReleaseRuntime,
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
    return {
      status: 'unverifiable' as const,
      exactWorker: false,
      reason: 'observation_superseded'
    }
  }
  // Legacy `running` maps to live; an absent peer verdict remains unverifiable.
  return {
    ...observation,
    status: observation.status === 'running' ? 'live' : (observation.status ?? 'unverifiable')
  }
}

export function resolvePinnedFederatedServer(
  runtime: WorkerTerminalReleaseRuntime,
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
  runtime: WorkerTerminalReleaseRuntime,
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
