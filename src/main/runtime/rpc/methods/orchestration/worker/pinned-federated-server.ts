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
    // Not found: removed, or re-paired, which adds the server as a new environment.
    if (error instanceof RuntimeEnvironmentStoreError && error.code === 'invalid_argument') {
      throw new OrchestrationError(
        'peer_changed',
        `Saved environment ${federated.environment_name} is no longer a paired server here, so this Orca cannot reach this worker. Re-pairing adds the server as a new environment.`
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
