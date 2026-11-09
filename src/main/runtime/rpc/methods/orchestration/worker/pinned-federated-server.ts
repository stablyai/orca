import type { WorkerTerminalReleaseRuntime } from '../../../../orchestration/terminal-authority/release/worker-terminal-release-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { FederatedDispatchRow } from '../../../../orchestration/db/orchestration-records'

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
