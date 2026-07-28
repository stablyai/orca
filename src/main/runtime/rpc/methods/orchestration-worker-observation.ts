import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { FederatedDispatchRow, WorkerDispatchRow } from '../../orchestration/types'

export async function inspectWorkerTerminal(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string
): Promise<{
  terminal: Awaited<ReturnType<OrcaRuntimeService['showTerminal']>> | null
  exact: boolean
  status: 'unattached' | 'missing' | 'identity_changed' | 'running' | 'exited'
}> {
  const worker = db.getWorkerDispatch(dispatchId)
  if (!worker?.agent_terminal_handle) {
    return { terminal: null, exact: false, status: 'unattached' }
  }
  const terminal = await runtime.showTerminal(worker.agent_terminal_handle).catch(() => null)
  if (!terminal) {
    return { terminal: null, exact: false, status: 'missing' }
  }
  const exact = db.isDispatchProcessCurrent({
    dispatchId,
    paneKey: runtime.getTerminalPaneKey(worker.agent_terminal_handle),
    processIncarnation: runtime.getTerminalProcessIncarnation(worker.agent_terminal_handle)
  })
  return {
    terminal,
    exact,
    status: exact ? (terminal.connected === false ? 'exited' : 'running') : 'identity_changed'
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
  observation: { status: string; exactWorker: boolean }
}> {
  return (await runtime.callOrchestrationWorkerServer(
    federated.environment_id,
    'orchestration.federationShow',
    { dispatchId: federated.dispatch_id },
    15_000
  )) as Awaited<ReturnType<typeof callFederatedWorkerShow>>
}
