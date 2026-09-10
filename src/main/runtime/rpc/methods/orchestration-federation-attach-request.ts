import { OrchestrationError } from '../../orchestration/orchestration-error'
import { ORCHESTRATION_FEDERATION_ATTEMPT_BOUND_WORKER_LEASE_PROTOCOL_VERSION } from '../../../../shared/protocol-version'
import type { FederationAttachStartInput } from './orchestration/federation/federation-start-schema'

/** Every federated attach must be durable, first-attempt, exact-worktree and on-protocol. */
export function assertFederationAttachmentRequest(
  params: FederationAttachStartInput,
  orchestrationMutation:
    | { callerFingerprint: string; requestId: string; method: string; payloadHash: string }
    | undefined
): asserts orchestrationMutation is {
  callerFingerprint: string
  requestId: string
  method: string
  payloadHash: string
} {
  if (!orchestrationMutation) {
    throw new OrchestrationError(
      'invalid_argument',
      'Federated worker attachment requires a durable retry request.'
    )
  }
  if (params.retryOf) {
    throw new OrchestrationError(
      'capability_unsupported',
      'Federated retry transfer is not supported by this worker peer.'
    )
  }
  if (params.worktree === 'current' || params.worktree === 'new-child') {
    throw new OrchestrationError(
      'invalid_argument',
      'A remote worker requires an exact existing worktree or new-top-level.'
    )
  }
  if (
    params.protocolVersion > ORCHESTRATION_FEDERATION_ATTEMPT_BOUND_WORKER_LEASE_PROTOCOL_VERSION
  ) {
    throw new OrchestrationError(
      'capability_unsupported',
      'Federated worker attachment requires the attempt-bound lease-transfer protocol.'
    )
  }
}
