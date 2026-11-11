// Worker-server half of today's remote attachments (a paired Orca drives a worker here).
// Frozen: bug fixes only. Code outside this folder imports it only through this module,
// except the DB layer, which uses legacy-remote-db-methods.ts.
/** The `orchestration.federation*` methods a paired Run home calls on this server. */
export { ORCHESTRATION_FEDERATION_ATTACH_METHODS } from './federation'
export { ORCHESTRATION_FEDERATION_CONTROL_METHODS } from './federation-control'
export { ORCHESTRATION_FEDERATION_RELAY_METHODS } from './federation-relay'

export { askRemoteRunHome } from './ask-remote'
export { releaseRemoteAttachment } from './federated-worker-release-host'
export { inspectRemoteAttachment } from './federation-attachment-observation'
export { federationRelayWireItem } from './federation-relay-wire'
export { replyToRemoteRunHome } from './reply-remote'
export { sendRemoteMessage } from './send-remote'
