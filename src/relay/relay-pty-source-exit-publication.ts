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
    try {
      session.settleExitPublication(record.identity, result)
      if (result.ok) {
        record.sourceExitState = 'published'
        counters.exitCommitted++
      } else {
        record.sourceExitState = 'idle'
        counters.exitRolledBack++
      }
    } finally {
      if (result.ok) {
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
