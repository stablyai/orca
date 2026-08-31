export { createLegacyDaemonAdapters } from './daemon-legacy-adapters'
export { initDaemonPtyProvider } from './daemon-provider-init'
export { restartDaemon, type RestartDaemonResult } from './daemon-provider-restart'
export {
  daemonOwnsFreshPersistentPtys,
  disconnectDaemon,
  getCurrentDaemonMacTccAttributionHealth,
  getDaemonEndpointFacts,
  getDaemonProvider,
  listLiveDaemonPtyIds,
  readDaemonPidRecord,
  replaceDaemonProvider,
  shutdownDaemon,
  type DaemonEndpointFacts
} from './daemon-provider-state'
export {
  cleanupDaemonForProtocol,
  type OrphanedDaemonCleanupResult
} from './daemon-protocol-cleanup'
export { WEDGED_DAEMON_GRACE_RETRIES } from './daemon-replacement-preflight'
