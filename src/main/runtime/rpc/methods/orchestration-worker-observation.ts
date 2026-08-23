import type { RuntimeTerminalInteractiveWait } from '../../../../shared/runtime-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { WorkerTerminalResourceRow } from '../../orchestration/worker-terminal-ownership'
import type {
  DispatchContextRow,
  FederatedDispatchRow,
  WorkerDispatchRow
} from '../../orchestration/types'

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
  return {
    terminal,
    exact,
    status: terminal.connected === false ? 'exited' : 'live',
    agentWait
  }
}

export type WorkerTerminalOwnerKind = 'worker' | 'remote_attachment'

export function resolveWorkerTerminalOwner(
  db: OrchestrationDb,
  dispatchId: string,
  owner: WorkerTerminalOwnerKind = 'worker'
): { terminalHandle: string | null; createdAt: string } | null {
  if (owner === 'remote_attachment') {
    const attachment = db.getRemoteDispatchAttachment(dispatchId)
    return attachment
      ? { terminalHandle: attachment.terminal_handle, createdAt: attachment.created_at }
      : null
  }
  const worker = db.getWorkerDispatch(dispatchId)
  return worker
    ? { terminalHandle: worker.agent_terminal_handle, createdAt: worker.created_at }
    : null
}

export function workerTerminalLeaseIsCurrent(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string,
  resource: WorkerTerminalResourceRow,
  owner: WorkerTerminalOwnerKind = 'worker'
): boolean {
  const terminalOwner = resolveWorkerTerminalOwner(db, dispatchId, owner)
  const authority = runtime.getOrchestrationDispatchAuthority(resource.terminal_handle)
  const hostScope =
    authority?.hostScope ?? runtime.getTerminalExecutionHostScope(resource.terminal_handle)
  const identity = {
    dispatchId,
    paneKey: runtime.getTerminalPaneKey(resource.terminal_handle),
    processIncarnation: runtime.getTerminalProcessIncarnation(resource.terminal_handle)
  }
  const processIsCurrent =
    owner === 'remote_attachment'
      ? db.isRemoteAttachmentProcessCurrent(identity)
      : db.isDispatchProcessCurrent(identity)
  return Boolean(
    terminalOwner?.terminalHandle === resource.terminal_handle &&
    hostScope &&
    resource.host_scope === JSON.stringify(hostScope) &&
    processIsCurrent &&
    !db.workerTerminalResourceHasIdentityConflict(resource.id)
  )
}

export function exposeContextOnlyWorker(dispatch: DispatchContextRow) {
  return {
    dispatch_id: dispatch.id,
    runtime_epoch: null,
    state: 'unsupervised' as const,
    stage: dispatch.capability_hash ? 'injected' : 'context_only',
    worktree_id: null,
    agent_terminal_handle: dispatch.assignee_handle,
    setup_state: 'not_applicable',
    effects: [],
    residualResources: [],
    startOptions: {},
    last_error: dispatch.last_failure,
    created_at: dispatch.created_at,
    updated_at: dispatch.completed_at ?? dispatch.created_at
  }
}

export async function showContextOnlyWorker(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatch: DispatchContextRow
) {
  const observation = await inspectWorkerTerminal(runtime, db, dispatch.id)
  return {
    dispatch,
    worker: exposeContextOnlyWorker(dispatch),
    terminal: observation.exact ? observation.terminal : null,
    observation: {
      status: observation.status,
      exactWorker: observation.exact,
      ...(observation.reason ? { reason: observation.reason } : {}),
      ...(observation.agentWait !== undefined ? { agentWait: observation.agentWait } : {})
    },
    terminalResource: null
  }
}

export function exposeWorker(worker: WorkerDispatchRow) {
  return {
    ...worker,
    effects: JSON.parse(worker.effects) as unknown[],
    residualResources: JSON.parse(worker.residual_resources) as unknown[],
    startOptions: JSON.parse(worker.start_options) as unknown
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
    pane_key?: string | null
    process_incarnation?: string | null
    setup_state: string
    effects: unknown[]
    residualResources: unknown[]
  }
  terminalResource?: unknown
  terminal: unknown
  observation: {
    status: string
    exactWorker: boolean
    reason?: string
    /** Absent from servers that predate the field; absence is unknown, not "not waiting". */
    agentWait?: RuntimeTerminalInteractiveWait | null
  }
}> {
  return (await runtime.callOrchestrationWorkerServer(
    federated.environment_id,
    'orchestration.federationShow',
    { dispatchId: federated.dispatch_id },
    15_000
  )) as Awaited<ReturnType<typeof callFederatedWorkerShow>>
}
