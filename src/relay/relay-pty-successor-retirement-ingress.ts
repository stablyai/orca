import type { RequestContext } from './dispatcher'
import type { PtyHandler } from './pty-handler'
import type { RelayPtySourcePublication } from './relay-pty-source-publication'
import type { RelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import type { PtyOwnershipTransferWireIdentity } from '../shared/pty-ownership-transfer-wire'
import { beginRelayPtySuccessorRetentionEvidence } from './relay-pty-successor-retention-evidence'
import { inspectRelayPtyOwnershipSuccessorCaptureEvidence } from './relay-pty-ownership-transfer-capture-cursor'
import { retainRelayPtyCommittedSourceCustody } from './relay-pty-committed-source-custody'
import { retireRelayPtyCoveredSourceDelivery } from './relay-pty-covered-source-retirement-execution'

/** Host-side composition only; the transport must negotiate this separate retirement contract. */
export function retireRelayPtySuccessorSourceDelivery(
  state: RelayPtyOwnershipTransferAdapterState,
  identity: PtyOwnershipTransferWireIdentity,
  savedBaseline: unknown,
  successorGeneration: number,
  retirementRecordSha256: string,
  recoveryOnly: boolean,
  context: RequestContext,
  dependencies: {
    handler: Pick<PtyHandler, 'beginOwnershipTransferCaptureIngress'>
    publication: Pick<RelayPtySourcePublication, 'prepareCoveredOwnershipTransferRetirement'> & {
      ownershipTransfer: Pick<
        RelayPtySourcePublication['ownershipTransfer'],
        'authorizesResumedTransferAtGeneration' | 'inspectSuccessorRetainedDelivery'
      >
    }
  }
) {
  const historical = state.transfers.get(identity.bridgeId)?.coveredSourceDeliveryRetirement
  if (recoveryOnly && !historical) {
    throw new Error('pty_source_retirement_recovery_journal_required')
  }
  const capture = beginRelayPtySuccessorRetentionEvidence(
    identity,
    savedBaseline,
    successorGeneration,
    context,
    {
      handler: dependencies.handler,
      source: dependencies.publication.ownershipTransfer,
      transfer: {
        inspectSuccessorCaptureEvidence: (bound, baseline) =>
          inspectRelayPtyOwnershipSuccessorCaptureEvidence(state, bound, baseline)
      }
    }
  )
  try {
    capture.assertCurrent()
    const actual = historical?.delivery ?? capture.inspect()?.delivery
    if (!actual) {
      throw new Error('pty_successor_retention_unavailable')
    }
    const custody = retainRelayPtyCommittedSourceCustody(state, identity, savedBaseline, actual)
    return retireRelayPtyCoveredSourceDelivery(
      state,
      custody,
      retirementRecordSha256,
      recoveryOnly,
      (retained) => {
        capture.assertCurrent()
        const cleanup = dependencies.publication.prepareCoveredOwnershipTransferRetirement(
          retained,
          context.clientId,
          successorGeneration
        )
        return {
          delivery: cleanup.delivery,
          assertCurrent: () => {
            capture.assertCurrent()
            cleanup.assertCurrent()
          },
          assertRemoved: () => {
            capture.assertCurrent()
            cleanup.assertRemoved()
          },
          remove: (assertAuthority: () => void) => {
            cleanup.remove(() => {
              capture.assertCurrent()
              assertAuthority()
            })
            capture.assertCurrent()
          }
        }
      }
    )
  } finally {
    capture.release()
  }
}
