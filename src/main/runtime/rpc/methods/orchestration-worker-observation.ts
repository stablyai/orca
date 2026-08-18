import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'
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
  const verdict = runtime.getTerminalLivenessVerdict?.(terminalHandle) ?? null
  if (verdict?.status === 'unverifiable') {
    return { terminal, exact, status: 'unverifiable', reason: verdict.reason }
  }
  if (verdict?.status === 'live') {
    return { terminal, exact, status: 'live' }
  }
  return {
    terminal,
    exact,
    status: terminal.connected === false ? 'exited' : 'live'
  }
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
      ...(observation.reason ? { reason: observation.reason } : {})
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
    setup_state: string
    effects: unknown[]
    residualResources: unknown[]
  }
  terminal: unknown
  observation: { status: string; exactWorker: boolean; reason?: string }
}> {
  return (await runtime.callOrchestrationWorkerServer(
    federated.environment_id,
    'orchestration.federationShow',
    { dispatchId: federated.dispatch_id },
    15_000
  )) as Awaited<ReturnType<typeof callFederatedWorkerShow>>
}
