import type { PtyHandler } from './pty-handler'
import type { RelayPtyOwnershipTransferAdapter } from './relay-pty-ownership-transfer-adapter'
import type { RelayPtyOwnershipTransferSourceResolver } from './relay-pty-ownership-transfer-source-resolution'
import type { RequestContext } from './dispatcher'
import type { PtyOwnershipTransferWireIdentity } from '../shared/pty-ownership-transfer-wire'
import { samePtySourceDelivery } from '../shared/pty-source-credit-contract'
import { parsePtyOwnershipCaptureBoundary } from '../shared/pty-ownership-capture-boundary'

export function beginRelayPtyOwnershipCaptureBoundary(
  value: PtyOwnershipTransferWireIdentity,
  context: RequestContext,
  dependencies: {
    handler: Pick<PtyHandler, 'beginOwnershipTransferCaptureIngress'>
    transfer: Pick<
      RelayPtyOwnershipTransferAdapter,
      'inspectPreparedCaptureCursor' | 'retainCaptureBoundary'
    >
    source: Pick<RelayPtyOwnershipTransferSourceResolver, 'authorizes' | 'inspectDrainedDelivery'>
  }
) {
  const identity = Object.freeze({ ...value })
  const { handler, transfer, source } = dependencies
  const authorized = () => {
    try {
      return (
        !context.isStale() &&
        context.sessionIdentity?.authenticated === true &&
        source.authorizes(
          identity.terminalId,
          identity.ownerLease,
          identity.sourceOwnerGeneration,
          context.clientId
        )
      )
    } catch {
      return false
    }
  }
  if (!authorized() || transfer.inspectPreparedCaptureCursor(identity) === null) {
    throw new Error('pty_ownership_transfer_capture_boundary_unavailable')
  }
  const lease = handler.beginOwnershipTransferCaptureIngress(
    identity.terminalId,
    identity.incarnationId,
    authorized
  )
  let released = false
  const release = () => {
    if (released) {
      return
    }
    released = true
    lease.release()
  }
  return Object.freeze({
    release,
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
      const rawCursor = lease.inspectRawCursor?.()
      if (rawCursor === null) {
        return null
      }
      const before = source.inspectDrainedDelivery(identity, context.clientId)
      const throughSeq = transfer.inspectPreparedCaptureCursor(identity)
      const after = source.inspectDrainedDelivery(identity, context.clientId)
      if (
        !before ||
        !after ||
        throughSeq === null ||
        !samePtySourceDelivery(before, after) ||
        before.receivedEndSu !== after.receivedEndSu ||
        transfer.inspectPreparedCaptureCursor(identity) !== throughSeq ||
        !authorized() ||
        !lease.isDrained()
      ) {
        return null
      }
      if (lease.inspectRawCursor?.() !== rawCursor) {
        return null
      }
      const boundary = parsePtyOwnershipCaptureBoundary(
        { version: 1, identity, throughSeq, delivery: after },
        identity
      )
      return rawCursor === undefined
        ? transfer.retainCaptureBoundary(identity, boundary)
        : transfer.retainCaptureBoundary(identity, boundary, rawCursor)
    }
  })
}
