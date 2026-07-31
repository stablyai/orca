import type { RelayDispatcher } from './dispatcher'
import {
  onceSinkSettlement,
  type RelayPtySourceDeliveryRecord,
  type RelayPtySourcePublicationCounters,
  type RelayPtySourceSendScheduler
} from './relay-pty-source-send-scheduler'
import type { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

type ExitParams = { id: string; code: number; incarnationId: string }

export function sealAndPublishPtySourceExit(options: {
  params: ExitParams
  record: RelayPtySourceDeliveryRecord
  deliveries: Map<string, RelayPtySourceDeliveryRecord>
  dispatcher: RelayDispatcher
  session: SshPtyConsumerSessionAdapter
  sender: RelayPtySourceSendScheduler
  counters: RelayPtySourcePublicationCounters
  onCapacity: (id: string) => void
}): boolean {
  const { params, record, deliveries, dispatcher, session, sender, counters, onCapacity } = options
  if (record.restoreRequired) {
    const published = dispatcher.tryNotifyPtyExit(params)
    if (published && deliveries.get(params.id) === record) {
      deliveries.delete(params.id)
    }
    return published
  }
  if (record.sourceExitState === 'pending') {
    // Why: an exit frame is in flight; its settlement drives the next step.
    return false
  }
  const probe = session.sourceDeliverySnapshotIfKnown(record.identity)
  if (!probe || probe.state === 'closed' || probe.state === 'closing') {
    if (probe?.exitPublished === true || record.sourceExitState === 'published') {
      // Why: the delivery completed healthily — the owner already has the credit-mode exit.
      if (deliveries.get(params.id) === record) {
        deliveries.delete(params.id)
      }
      return true
    }
    // Why: the delivery was canceled out from under the record; never touch the sealed
    // ledger — the exit flows as a legacy broadcast instead.
    const published = record.legacyExitAccepted
      ? dispatcher.tryNotifyPtyExitToMatchingClients(
          (clientId) => session.deliveryMode(clientId) === 'source-owner',
          params
        )
      : dispatcher.tryNotifyPtyExit(params)
    if (published && deliveries.get(params.id) === record) {
      deliveries.delete(params.id)
    }
    return published
  }
  if (!record.sealed) {
    session.sealDelivery(record.identity)
    record.sealed = true
  }
  sender.pump(record)
  const snapshot = session.sourceDeliverySnapshot(record.identity)
  if (snapshot.sentEndSu !== snapshot.receivedEndSu) {
    return false
  }
  if (!record.legacyExitAccepted) {
    record.legacyExitAccepted = dispatcher.projectPtyExitToMatchingClients(
      (clientId) => session.deliveryMode(clientId) !== 'source-owner',
      params
    )
    if (!record.legacyExitAccepted) {
      return false
    }
  }
  if (record.sourceExitState !== 'idle') {
    return true
  }
  record.sourceExitState = 'pending'
  const settle = onceSinkSettlement((result) => {
    if (result.ok) {
      record.sourceExitState = 'published'
      counters.exitCommitted++
    } else {
      record.sourceExitState = 'idle'
      counters.exitRolledBack++
    }
    let deliveryGone = false
    let settlementFailed = false
    try {
      // Why: a client cancel or rotation can close the delivery while this frame is in
      // flight; settling a closed ledger entry throws out of a bare socket write/drain
      // callback (dispatcher-client-writer releaseEntry) straight into uncaughtException.
      deliveryGone =
        session.sourceDeliverySnapshotIfKnown(record.identity)?.state !== 'sealed-unsettled'
      if (!deliveryGone) {
        session.settleExitPublication(record.identity, result)
      }
    } catch (err) {
      settlementFailed = true
      process.stderr.write(
        `[pty-source-exit] exit settlement failed for ${params.id}: ${
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        }\n`
      )
    } finally {
      if (result.ok || deliveryGone || settlementFailed) {
        onCapacity(params.id)
      }
    }
  })
  const accepted = dispatcher.tryNotifyPtyExitToClient(record.clientId, params, settle)
  if (!accepted && record.sourceExitState === 'pending') {
    record.sourceExitState = 'idle'
  }
  return accepted
}
