// Run-home half of today's remote attachments (`worker-start --on` drives a worker on a paired Orca).
// Frozen: bug fixes only. Code outside this folder imports it only through this module,
// except the DB layer, which uses legacy-remote-home-db-methods.ts.
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
