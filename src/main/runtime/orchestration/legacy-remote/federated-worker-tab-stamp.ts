import type { FederationAttachStartInput } from '../../../../shared/rpc-contract/orchestration/orchestration-federation-start-params'
import type { WorkerTabStamp } from '../../../../shared/orchestration/workers/worker-tab-stamp'

/** Only the Run home knows the lineage; the receiving host owns its newly allocated leaf. */
export function workerTabStampForFederatedStart(
  params: FederationAttachStartInput
): WorkerTabStamp | undefined {
  const origin = params.workerTab?.origin
  if (
    params.terminal ||
    !origin ||
    origin.runId !== params.runId ||
    origin.dispatchId !== params.dispatchId ||
    origin.taskId !== params.taskId
  ) {
    return undefined
  }
  const { workerLeafId: _remoteLeaf, ...lineage } = origin
  return { origin: { ...lineage, stopRequiresHome: true } }
}
