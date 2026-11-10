// Worker-server half of today's remote attachments (a paired Orca drives a worker here).
// Frozen: bug fixes only. Code outside this folder imports it only through this module.
import { attachFederatedDispatchObservationFence } from './federated-dispatch-observation-fence'
import type { FederatedDispatchObservationFenceMethods } from './federated-dispatch-observation-fence'
import { ORCHESTRATION_FEDERATION_ATTACH_METHODS } from './federation'
import { ORCHESTRATION_FEDERATION_CONTROL_METHODS } from './federation-control'
import { ORCHESTRATION_FEDERATION_RELAY_METHODS } from './federation-relay'
import { attachFederationRelayEnqueue } from './federation-relay-enqueue'
import type { FederationRelayEnqueueMethods } from './federation-relay-enqueue'
import { attachFederationRelayItem } from './federation-relay-item'
import type { FederationRelayItemMethods } from './federation-relay-item'
import { attachFederationRelayReportAcknowledgment } from './federation-relay-report-acknowledgment'
import type { FederationRelayReportAcknowledgmentMethods } from './federation-relay-report-acknowledgment'
import { attachRemoteDispatchAttachmentAuthority } from './remote-dispatch-attachment-authority'
import type { RemoteDispatchAttachmentAuthorityMethods } from './remote-dispatch-attachment-authority'
import { attachRemoteDispatchAttachmentCreate } from './remote-dispatch-attachment-create'
import type { RemoteDispatchAttachmentCreateMethods } from './remote-dispatch-attachment-create'
import { attachRemoteDispatchAttachmentRelease } from './remote-dispatch-attachment-release'
import type { RemoteDispatchAttachmentReleaseMethods } from './remote-dispatch-attachment-release'
import { attachRemoteDispatchAttachmentStop } from './remote-dispatch-attachment-stop'
import type { RemoteDispatchAttachmentStopMethods } from './remote-dispatch-attachment-stop'
import { attachRemoteQuestionStore } from './remote-question-store'
import type { RemoteQuestionStoreMethods } from './remote-question-store'

/** The `orchestration.federation*` methods a paired Run home calls on this server. */
export const LEGACY_REMOTE_METHODS = [
  ...ORCHESTRATION_FEDERATION_ATTACH_METHODS,
  ...ORCHESTRATION_FEDERATION_RELAY_METHODS,
  ...ORCHESTRATION_FEDERATION_CONTROL_METHODS
]

export type LegacyRemoteDbMethods = FederatedDispatchObservationFenceMethods &
  RemoteDispatchAttachmentCreateMethods &
  RemoteDispatchAttachmentAuthorityMethods &
  RemoteDispatchAttachmentReleaseMethods &
  RemoteDispatchAttachmentStopMethods &
  FederationRelayEnqueueMethods &
  RemoteQuestionStoreMethods &
  FederationRelayItemMethods &
  FederationRelayReportAcknowledgmentMethods

export function attachLegacyRemoteDbMethods(ctor: { prototype: object }): void {
  attachFederatedDispatchObservationFence(ctor)
  attachRemoteDispatchAttachmentCreate(ctor)
  attachRemoteDispatchAttachmentAuthority(ctor)
  attachRemoteDispatchAttachmentRelease(ctor)
  attachRemoteDispatchAttachmentStop(ctor)
  attachFederationRelayEnqueue(ctor)
  attachRemoteQuestionStore(ctor)
  attachFederationRelayItem(ctor)
  attachFederationRelayReportAcknowledgment(ctor)
}

export { askRemoteRunHome } from './ask-remote'
export { releaseRemoteAttachment } from './federated-worker-release-host'
export { inspectRemoteAttachment } from './federation-attachment-observation'
export { encodeFederatedControlMessage } from './federation-control-message'
export type { FederatedLifecycleSettlement } from './federation-lifecycle-settlement'
export type { FederationRelayAcknowledgment } from './federation-relay-report-acknowledgment'
export { federationRelayWireItem } from './federation-relay-wire'
export { replyToRemoteRunHome } from './reply-remote'
export { sendRemoteMessage } from './send-remote'
