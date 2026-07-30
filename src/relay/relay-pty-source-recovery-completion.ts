import type { RelayDispatcher, SinkWriteSettlement } from './dispatcher'
import type { RelayPtySourceDeliveryRecord } from './relay-pty-source-send-scheduler'
import type { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

function onceSettlement(
  callback: (result: SinkWriteSettlement) => void
): (result: SinkWriteSettlement) => void {
  let settled = false
  return (result) => {
    if (settled) {
      return
    }
    settled = true
    callback(result)
  }
}

export function completePtySourceRecovery(options: {
  record: RelayPtySourceDeliveryRecord
  deliveries: Map<string, RelayPtySourceDeliveryRecord>
  dispatcher: RelayDispatcher
  session: SshPtyConsumerSessionAdapter
  onCompleted: (id: string) => void
}): void {
  const { record, deliveries, dispatcher, session, onCompleted } = options
  const recoveryEndSu = record.recoveryEndSu
  const checkpointSourceEndSu = record.recoveryCheckpointSourceEndSu
  if (
    record.activating ||
    record.sending ||
    record.recoveryCompletionPending ||
    recoveryEndSu === null ||
    checkpointSourceEndSu === null ||
    session.sourceDeliverySnapshot(record.identity).sentEndSu < recoveryEndSu
  ) {
    return
  }
  record.recoveryCompletionPending = true
  const settle = onceSettlement((result) => {
    if (deliveries.get(record.identity.id) !== record) {
      return
    }
    record.recoveryCompletionPending = false
    if (!result.ok) {
      return
    }
    record.recoveryEndSu = null
    record.recoveryCheckpointSourceEndSu = null
    onCompleted(record.identity.id)
  })
  const accepted = dispatcher.tryNotifyClient(
    record.clientId,
    'pty.recoveryComplete',
    {
      id: record.identity.id,
      clientGeneration: record.identity.clientGeneration,
      ownerGeneration: record.identity.ownerGeneration,
      ptyIncarnation: record.identity.ptyIncarnation,
      deliveryToken: record.identity.deliveryToken,
      checkpointSourceEndSu,
      recoveryEndSu
    },
    settle
  )
  if (!accepted) {
    settle({ ok: false, error: new Error('PTY recovery completion was not admitted') })
  }
}
