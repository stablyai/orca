import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { FederatedDispatchRow } from './types'
import { getOrchestrationPeerCapabilityCache } from './orchestration-peer-capability-cache'

export async function resolveFederatedLifecycleSettlementCapability(
  runtime: OrcaRuntimeService,
  federated: FederatedDispatchRow,
  pairingRevision: number | undefined
) {
  if (federated.protocol_version < ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION) {
    return null
  }
  return getOrchestrationPeerCapabilityCache(runtime).resolve({
    peerFingerprint: federated.peer_fingerprint,
    expectedRuntimeEpoch: federated.remote_runtime_epoch,
    capability: ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY,
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
