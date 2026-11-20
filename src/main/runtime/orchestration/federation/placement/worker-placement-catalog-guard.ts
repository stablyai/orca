import { OrchestrationError } from '../../orchestration-error'
import { remoteServerPin, remoteRunLinkPinMatches } from '../../db/remote-owned/remote-run-links'
import { pairedOrchestrationPeers, type OrchestrationWorkerServer } from '../environment-transport'
import { environmentStoreWriteCount } from '../../../../../shared/remote-runtime/host-store/runtime-environment-store-worker-client'
import type { RuntimeRequestGuard } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { CatalogDeadline, CatalogOwnerRegistry } from './worker-placement-catalog-deadline'

export function workerPlacementCatalogGuard(
  registry: CatalogOwnerRegistry,
  server: OrchestrationWorkerServer,
  deadline: CatalogDeadline,
  stopped: () => boolean
): RuntimeRequestGuard {
  const pin = remoteServerPin(server)
  const assertActive = (): void => {
    if (stopped()) {
      throw new OrchestrationError('runtime_environment_changed', 'Catalog owner is disposed.', {
        effectsApplied: false
      })
    }
    if (!deadline.active) {
      throw new OrchestrationError('runtime_timeout', 'Catalog read deadline expired.', {
        effectsApplied: false
      })
    }
  }
  return async (connection) => {
    assertActive()
    const observation = await registry.resolve(server.environmentId, deadline)
    assertActive()
    const generation = environmentStoreWriteCount()
    const peers = pairedOrchestrationPeers(
      connection.hostPublicKeyB64,
      connection.credential.deviceToken
    )
    return () => {
      assertActive()
      if (!registry.isCurrent(observation) || generation !== environmentStoreWriteCount()) {
        return false
      }
      if (
        !remoteRunLinkPinMatches(pin, remoteServerPin(observation.value)) ||
        peers.peerFingerprint !== pin.peer_fingerprint ||
        peers.homePeerFingerprint !== pin.home_fingerprint
      ) {
        throw new OrchestrationError(
          'server_pairing_changed',
          'Catalog read belongs to an earlier pairing.'
        )
      }
      return true
    }
  }
}
