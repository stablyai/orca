import type { WorkerTerminalReleaseRuntime } from '../../../../orchestration/terminal-authority/release/worker-terminal-release-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { FederatedDispatchRow } from '../../../../orchestration/db/orchestration-records'
import { RuntimeEnvironmentStoreError } from '../../../../../../shared/remote-runtime/host-store/runtime-environment-store-records'

export function resolvePinnedFederatedServer(
  runtime: WorkerTerminalReleaseRuntime,
  federated: FederatedDispatchRow
) {
  let server
  try {
    server = runtime.resolveOrchestrationWorkerServer(federated.environment_id)
  } catch (error) {
    // Re-pairing adds the server as a new environment, so the one this worker ran on is gone.
    if (error instanceof RuntimeEnvironmentStoreError) {
      throw new OrchestrationError(
        'peer_changed',
        `Saved environment ${federated.environment_name} was removed or re-paired since this worker started, so this Orca can no longer reach it.`
      )
    }
    throw error
  }
  if (server.peerFingerprint !== federated.peer_fingerprint) {
    throw new OrchestrationError(
      'peer_changed',
      `Saved environment ${federated.environment_name} now identifies a different Orca server.`
    )
  }
  return server
}
