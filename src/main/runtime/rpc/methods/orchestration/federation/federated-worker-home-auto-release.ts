import type { WorkerTerminalReleaseRuntime } from '../../../../orchestration/worker-terminal-release-runtime'
import { resolvePinnedFederatedServer } from '../worker/worker-observation'
import { releaseFederatedWorker } from './federated-worker-release'

/** The home's deadline for a host that did not arm its own; the host's takeover and ownership checks still refuse it. */
export async function releaseFederatedWorkerAtHomeDeadline(
  runtime: WorkerTerminalReleaseRuntime,
  dispatchId: string
): Promise<void> {
  const db = runtime.getOrchestrationDb()
  const federated = db.getFederatedDispatch(dispatchId)
  if (!federated) {
    return
  }
  // A thrown or unknown attempt keeps the deadline the claim postponed, so it runs again.
  const receipt = await releaseFederatedWorker({
    runtime,
    server: resolvePinnedFederatedServer(runtime, federated),
    federated,
    dispatchId,
    requestId: `home_auto_release_${dispatchId}_${Date.now()}`,
    admit: () => db.isFederatedHomeAutoReleaseArmed(dispatchId)
  })
  if (receipt.state !== 'release_unknown') {
    db.endFederatedHomeAutoRelease(dispatchId)
  }
}
