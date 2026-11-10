// Run-home half of today's remote attachments (`worker-start --on` drives a worker on a paired Orca).
// Frozen: bug fixes only. Code outside this folder imports it only through this module.
import { attachFederatedDispatchStore } from './federated-dispatch-store'
import type { FederatedDispatchStoreMethods } from './federated-dispatch-store'
import { attachFederatedHomeAutoReleaseStore } from './federated-home-auto-release-store'
import type { FederatedHomeAutoReleaseStoreMethods } from './federated-home-auto-release-store'
import { attachFederatedWorkerStartReconcile } from './federated-worker-start-reconcile'
import type { FederatedWorkerStartReconcileMethods } from './federated-worker-start-reconcile'
import { attachFederationRelayImport } from './federation-relay-import'
import type { FederationRelayImportMethods } from './federation-relay-import'

export type LegacyRemoteHomeDbMethods = FederatedWorkerStartReconcileMethods &
  FederatedDispatchStoreMethods &
  FederationRelayImportMethods &
  FederatedHomeAutoReleaseStoreMethods

export function attachLegacyRemoteHomeDbMethods(ctor: { prototype: object }): void {
  attachFederatedWorkerStartReconcile(ctor)
  attachFederatedDispatchStore(ctor)
  attachFederationRelayImport(ctor)
  attachFederatedHomeAutoReleaseStore(ctor)
}

/** The one place a worker start leaves the local path: `worker-start --on <server>`. */
export { startFederatedWorker } from './federated-worker-start'

export {
  applyFederatedFleetObservations,
  readFederatedFleetSnapshots
} from './federated-fleet-snapshot'
export { releaseFederatedWorkerAtHomeDeadline } from './federated-worker-home-auto-release'
export { readFederatedWorkerOutput } from './federated-worker-read'
export { releaseFederatedWorker, retainFederatedWorker } from './federated-worker-release'
export { showFederatedWorker } from './federated-worker-show'
export {
  clearFederationAckCheckpoints,
  releaseFederationAckCheckpoint
} from './federation-ack-checkpoints'
export { FederationAcknowledgmentRecovery } from './federation-acknowledgment-recovery'
export { syncFederatedDispatch } from './federation-sync'
export { resolvePinnedFederatedServer } from './pinned-federated-server'
export { federatedControlMailRefusal, sendFederatedControlMail } from './send-control-mail'
