import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_AUTO_RELEASE_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../shared/protocol-version'
import { STRUCTURED_WORKER_HANDLE_PREFIX } from '../../../shared/structured-worker-handle'
import type { FederationRuntime } from './federation-runtime'
import type { FederatedDispatchRow } from './types'
import { getOrchestrationPeerCapabilityCache } from './orchestration-peer-capability-cache'
import { WORKER_RELEASABLE_STATES } from './worker-terminal-ownership'

export async function resolveFederatedLifecycleSettlementCapability(
  runtime: FederationRuntime,
  federated: FederatedDispatchRow,
  pairingRevision: number | undefined
) {
  if (federated.protocol_version < ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION) {
    return null
  }
  return resolveFederatedHostCapability(
    runtime,
    federated,
    pairingRevision,
    ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY
  )
}

function resolveFederatedHostCapability(
  runtime: FederationRuntime,
  federated: FederatedDispatchRow,
  pairingRevision: number | undefined,
  capability: RuntimeCapability
) {
  return getOrchestrationPeerCapabilityCache(runtime).resolve({
    peerFingerprint: federated.peer_fingerprint,
    expectedRuntimeEpoch: federated.remote_runtime_epoch,
    capability,
    probe: () =>
      runtime.callOrchestrationWorkerServer(
        federated.environment_id,
        'status.get',
        undefined,
        15_000,
        undefined,
        { expectedEnvironmentPairingRevision: pairingRevision }
      ) as Promise<RuntimeStatus>
  })
}

/** A settled worker on a host that cannot release it alone gets the home's deadline, if that host releases on request. */
export async function armHomeAutoReleaseForOlderHost(
  runtime: FederationRuntime,
  dispatchId: string,
  pairingRevision: number | undefined
): Promise<void> {
  const db = runtime.getOrchestrationDb()
  const federated = db.getFederatedDispatch(dispatchId)
  const worker = db.getWorkerDispatch(dispatchId)
  if (
    !federated ||
    db.workerAutoReleaseEnabled?.() === false ||
    federated.home_auto_release_state !== null ||
    // Chat workers stay on manual release, as on hosts that release by themselves.
    !federated.remote_terminal_handle ||
    federated.remote_terminal_handle.startsWith(STRUCTURED_WORKER_HANDLE_PREFIX) ||
    !worker ||
    !WORKER_RELEASABLE_STATES.includes(worker.state) ||
    worker.stage === 'released'
  ) {
    return
  }
  // An unanswered probe still arms: settlement is never revisited, and the deadline re-checks release support.
  const [hostReleases, releasable] = await Promise.all(
    [
      ORCHESTRATION_WORKER_AUTO_RELEASE_RUNTIME_CAPABILITY,
      ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY
    ].map((capability) =>
      resolveFederatedHostCapability(runtime, federated, pairingRevision, capability).catch(
        () => undefined
      )
    )
  )
  if (!hostReleases?.supported && releasable?.supported !== false) {
    db.armFederatedHomeAutoRelease(dispatchId)
  }
}
