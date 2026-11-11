// The DB layer's only way into this folder; keep it free of rpc and runtime imports.
import { attachFederatedDispatchObservationFence } from './federated-dispatch-observation-fence'
import type { FederatedDispatchObservationFenceMethods } from './federated-dispatch-observation-fence'
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

export type { FederationRelayAcknowledgment } from './federation-relay-report-acknowledgment'

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
