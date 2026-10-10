import type {
  ORCHESTRATION_WORKER_READ_SOURCES,
  OrchestrationWorkerReadResult
} from '../../../../../../shared/orchestration-worker-output'
import { ORCHESTRATION_FEDERATION_STRUCTURED_READ_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { getOrchestrationPeerCapabilityCache } from '../../../../orchestration/orchestration-peer-capability-cache'
import type { FederatedDispatchRow } from '../../../../orchestration/types'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { readLegacyFederatedTerminal } from '../worker/worker-legacy-federated-read'
import type { resolvePinnedFederatedServer } from '../worker/worker-observation'

export async function readFederatedWorkerOutput(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  server: ReturnType<typeof resolvePinnedFederatedServer>
  federated: FederatedDispatchRow
  dispatchId: string
  source: (typeof ORCHESTRATION_WORKER_READ_SOURCES)[number] | undefined
  cursor: string | number | undefined
  limit: number | undefined
}): Promise<unknown> {
  const observationFence = args.db.captureFederatedDispatchObservationFence(args.dispatchId)
  if (!observationFence) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Federated Worker Dispatch ${args.dispatchId} has no observation projection.`
    )
  }
  const capabilities = getOrchestrationPeerCapabilityCache(args.runtime)
  // Hosts that serve `orchestration.federationReadOutput` shipped before the capability string
  // did, so ask the method itself and let `method_not_found` be the only downgrade signal.
  const known = capabilities.knownSupport(
    args.federated.peer_fingerprint,
    args.federated.remote_runtime_epoch,
    ORCHESTRATION_FEDERATION_STRUCTURED_READ_RUNTIME_CAPABILITY
  )
  const expectedRuntimeEpoch = known?.runtimeEpoch ?? args.federated.remote_runtime_epoch
  if (known?.supported === false) {
    const legacy = await readLegacy(args)
    projectRemoteRuntimeEpoch(args.db, observationFence, legacy.remoteRuntimeEpoch)
    if (legacy.remoteRuntimeEpoch !== expectedRuntimeEpoch) {
      capabilities.observeEpoch(args.federated.peer_fingerprint, legacy.remoteRuntimeEpoch)
    }
    return legacy
  }
  try {
    const remote = (await args.runtime.callOrchestrationWorkerServer(
      args.server.environmentId,
      'orchestration.federationReadOutput',
      {
        dispatchId: args.dispatchId,
        cursor: args.cursor,
        limit: args.limit,
        source: args.source
      },
      15_000,
      undefined,
      { expectedEnvironmentPairingRevision: args.server.pairingRevision }
    )) as { runtimeEpoch: string; output: OrchestrationWorkerReadResult }
    capabilities.remember(
      args.federated.peer_fingerprint,
      remote.runtimeEpoch,
      ORCHESTRATION_FEDERATION_STRUCTURED_READ_RUNTIME_CAPABILITY,
      true,
      expectedRuntimeEpoch
    )
    projectRemoteRuntimeEpoch(args.db, observationFence, remote.runtimeEpoch)
    return {
      ...remote.output,
      server: { environmentId: args.server.environmentId, name: args.server.name },
      remoteRuntimeEpoch: remote.runtimeEpoch
    }
  } catch (error) {
    if (!(error instanceof OrchestrationError) || error.code !== 'method_not_found') {
      throw error
    }
    const legacy = await readLegacy(args)
    capabilities.remember(
      args.federated.peer_fingerprint,
      legacy.remoteRuntimeEpoch,
      ORCHESTRATION_FEDERATION_STRUCTURED_READ_RUNTIME_CAPABILITY,
      false,
      expectedRuntimeEpoch
    )
    projectRemoteRuntimeEpoch(args.db, observationFence, legacy.remoteRuntimeEpoch)
    return legacy
  }
}

function projectRemoteRuntimeEpoch(
  db: OrchestrationDb,
  fence: NonNullable<ReturnType<OrchestrationDb['captureFederatedDispatchObservationFence']>>,
  runtimeEpoch: string
): void {
  db.projectFederatedDispatchObservation(fence, () => {
    db.updateFederatedDispatchRuntimeEpoch(fence.dispatch_id, runtimeEpoch)
  })
}

function readLegacy(args: Parameters<typeof readFederatedWorkerOutput>[0]) {
  return readLegacyFederatedTerminal({
    runtime: args.runtime,
    server: args.server,
    federated: args.federated,
    workerState: args.db.getWorkerDispatch(args.dispatchId)?.state ?? 'unknown',
    dispatchId: args.dispatchId,
    source: args.source,
    cursor: args.cursor,
    limit: args.limit
  })
}
