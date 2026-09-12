import type { PtyHandler } from './pty-handler'
import type { RequestContext } from './dispatcher'
import type { RelayPtyOwnershipTransferAdapter } from './relay-pty-ownership-transfer-adapter'
import type { RelayPtyOwnershipTransferSourceResolver } from './relay-pty-ownership-transfer-source-resolution'
import type { PtyOwnershipTransferWireIdentity } from '../shared/pty-ownership-transfer-wire'
import { parsePtyOwnershipCaptureBaseline } from '../shared/pty-ownership-capture-baseline'
import { samePtySourceDelivery } from '../shared/pty-source-credit-contract'

/** Retention evidence is neither a source ACK nor destination custody or retirement authority. */
export function beginRelayPtySuccessorRetentionEvidence(
  identity: PtyOwnershipTransferWireIdentity,
  savedBaseline: unknown,
  successorGeneration: number,
  context: RequestContext,
  dependencies: {
    handler: Pick<PtyHandler, 'beginOwnershipTransferCaptureIngress'>
    transfer: Pick<RelayPtyOwnershipTransferAdapter, 'inspectSuccessorCaptureEvidence'>
    source: Pick<
      RelayPtyOwnershipTransferSourceResolver,
      'authorizesResumedTransferAtGeneration' | 'inspectSuccessorRetainedDelivery'
    >
  }
) {
  const baseline = parsePtyOwnershipCaptureBaseline(savedBaseline, identity)
  const bound = baseline.boundary.identity
  if (
    !Number.isSafeInteger(successorGeneration) ||
    successorGeneration <= bound.sourceOwnerGeneration
  ) {
    throw new Error('pty_ownership_transfer_successor_generation_invalid')
  }
  const authorized = () => {
    try {
      return (
        !context.isStale() &&
        context.sessionIdentity?.authenticated === true &&
        dependencies.source.authorizesResumedTransferAtGeneration(
          bound.ownerLease,
          successorGeneration,
          context.clientId
        )
      )
    } catch {
      return false
    }
  }
  if (!authorized() || !dependencies.transfer.inspectSuccessorCaptureEvidence(bound, baseline)) {
    throw new Error('pty_successor_retention_unavailable')
  }
  const lease = dependencies.handler.beginOwnershipTransferCaptureIngress(
    bound.terminalId,
    bound.incarnationId,
    authorized
  )
  let released = false
  const release = () => {
    if (!released) {
      released = true
      lease.release()
    }
  }
  return Object.freeze({
    release,
    assertCurrent: () => {
      if (released || !authorized() || !lease.isCurrent() || !lease.isDrained()) {
        throw new Error('pty_successor_retention_ingress_unavailable')
      }
    },
    inspect: () => {
      if (released) {
        return null
      }
      if (!authorized()) {
        release()
        return null
      }
      if (!lease.isDrained()) {
        return null
      }
      const coverage = dependencies.transfer.inspectSuccessorCaptureEvidence(bound, baseline)
      if (!coverage) {
        return null
      }
      const before = dependencies.source.inspectSuccessorRetainedDelivery(
        bound,
        context.clientId,
        coverage.delivery
      )
      const after = dependencies.source.inspectSuccessorRetainedDelivery(
        bound,
        context.clientId,
        coverage.delivery
      )
      const finalCoverage = dependencies.transfer.inspectSuccessorCaptureEvidence(bound, baseline)
      if (
        !before ||
        !after ||
        !samePtySourceDelivery(before, after) ||
        before.windowSu !== after.windowSu ||
        before.receivedEndSu !== after.receivedEndSu ||
        before.sentEndSu !== after.sentEndSu ||
        before.creditedEndSu !== after.creditedEndSu ||
        JSON.stringify(finalCoverage) !== JSON.stringify(coverage) ||
        !authorized() ||
        !lease.isDrained()
      ) {
        return null
      }
      return Object.freeze({
        identity: bound,
        modelSha256: baseline.modelSha256,
        journalThroughSeq: coverage.throughSeq,
        coveredReceivedEndSu: coverage.delivery.receivedEndSu,
        delivery: after
      })
    }
  })
}
