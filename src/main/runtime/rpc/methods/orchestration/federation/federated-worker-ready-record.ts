import type { OrchestrationDb } from '../../../../orchestration/db'
import type { ReadyRemoteFederatedWorkerStartReceipt } from './federated-attach-receipt'

/** Records where a ready remote worker lives and that the server accepted its input. */
export function recordReadyFederatedDispatch(
  db: OrchestrationDb,
  dispatchId: string,
  remote: ReadyRemoteFederatedWorkerStartReceipt
): void {
  db.updateFederatedDispatchResources({
    dispatchId,
    remoteRuntimeEpoch: remote.runtimeEpoch,
    worktreeId: remote.worktreeId,
    terminalHandle: remote.terminalHandle
  })
  db.recordWorkerStage({
    dispatchId,
    stage: 'remote_input_accepted',
    worktreeId: remote.worktreeId,
    terminalHandle: remote.terminalHandle,
    setupState: remote.setup?.state,
    effects: remote.effects,
    residualResources: remote.residualResources
  })
}
