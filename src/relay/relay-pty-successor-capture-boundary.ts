import type { PtyHandler } from './pty-handler'
import type { RequestContext } from './dispatcher'
import type { RelayPtyOwnershipTransferAdapter } from './relay-pty-ownership-transfer-adapter'
import type { RelayPtyOwnershipTransferSourceResolver } from './relay-pty-ownership-transfer-source-resolution'
import type { PtyOwnershipTransferWireIdentity } from '../shared/pty-ownership-transfer-wire'
import { parsePtyOwnershipCaptureBaseline } from '../shared/pty-ownership-capture-baseline'
import { beginRelayPtyOwnershipCaptureBoundary } from './relay-pty-ownership-capture-boundary'

/** Retains ingress for exact saved-capture evidence; does not select a model or retire delivery. */
export function beginRelayPtySuccessorCaptureBoundary(
  identity: PtyOwnershipTransferWireIdentity,
  savedBaseline: unknown,
  successorGeneration: number,
  context: RequestContext,
  dependencies: {
    handler: Pick<PtyHandler, 'beginOwnershipTransferCaptureIngress'>
    transfer: Pick<RelayPtyOwnershipTransferAdapter, 'inspectSuccessorCaptureEvidence'>
    source: Pick<
      RelayPtyOwnershipTransferSourceResolver,
      'authorizesResumedTransferAtGeneration' | 'inspectSuccessorDrainedDelivery'
    >
  }
) {
  const baseline = parsePtyOwnershipCaptureBaseline(savedBaseline, identity)
  if (
    !Number.isSafeInteger(successorGeneration) ||
    successorGeneration <= identity.sourceOwnerGeneration
  ) {
    throw new Error('pty_ownership_transfer_successor_generation_invalid')
  }
  return beginRelayPtyOwnershipCaptureBoundary(identity, context, {
    handler: dependencies.handler,
    transfer: {
      inspectPreparedCaptureCursor: (current) =>
        dependencies.transfer.inspectSuccessorCaptureEvidence(current, baseline)?.throughSeq ??
        null,
      retainCaptureBoundary: (_current, inspected) => {
        const expected = dependencies.transfer.inspectSuccessorCaptureEvidence(_current, baseline)
        if (!expected || JSON.stringify(inspected) !== JSON.stringify(expected)) {
          throw new Error('pty_ownership_transfer_successor_boundary_changed')
        }
        return expected
      }
    },
    source: {
      authorizes: (_id, ownerLease, _historicalGeneration, clientId) =>
        dependencies.source.authorizesResumedTransferAtGeneration(
          ownerLease,
          successorGeneration,
          clientId
        ),
      inspectDrainedDelivery: (current, clientId) => {
        const expected = dependencies.transfer.inspectSuccessorCaptureEvidence(
          baseline.boundary.identity,
          baseline
        )
        return expected
          ? dependencies.source.inspectSuccessorDrainedDelivery(
              current,
              clientId,
              expected.delivery
            )
          : null
      }
    }
  })
}
