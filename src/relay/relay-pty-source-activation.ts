import type {
  PtySourceRecoveryCheckpoint,
  PtySourceRecoveryRequest,
  PtySourceRecoveryResult
} from '../shared/pty-source-recovery-contract'
import type { PtySourceReceivingActivation } from '../shared/pty-source-receiving-activation'
import type { PtySourceDeliveryIdentity } from '../shared/pty-source-credit-contract'
import type { RequestContext } from './dispatcher'
import type {
  RelayPtySourceDeliveryRecord,
  RelayPtySourceSendScheduler
} from './relay-pty-source-send-scheduler'
import type { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

export function createPtySourceReceivingActivation(
  identity: PtySourceDeliveryIdentity,
  checkpointSourceEndSu: number,
  recoveryEndSu: number
): PtySourceReceivingActivation {
  return Object.freeze({
    status: 'pending',
    clientGeneration: identity.clientGeneration,
    ownerGeneration: identity.ownerGeneration,
    ptyIncarnation: identity.ptyIncarnation,
    deliveryToken: identity.deliveryToken,
    checkpointSourceEndSu,
    recoveryEndSu
  })
}

export function registerPtySourceActivationSettlement(options: {
  id: string
  record: RelayPtySourceDeliveryRecord
  context: RequestContext
  deliveries: Map<string, RelayPtySourceDeliveryRecord>
  session: SshPtyConsumerSessionAdapter
  sender: RelayPtySourceSendScheduler
  onCapacity: (id: string) => void
}): void {
  const { id, record, context, deliveries, session, sender, onCapacity } = options
  context.onResponseSettled!((result) => {
    if (deliveries.get(id) !== record || !record.activating) {
      return
    }
    if (!result.ok) {
      if (!record.activationRecoveryRequest) {
        session.cancelDelivery(record.identity, 'activation-publication-failed')
        deliveries.delete(id)
      }
      return
    }
    record.activating = false
    sender.completeRecoveryIfReady(record)
    sender.pump(record)
    onCapacity(id)
  })
}

export function registerCanceledPtySourceRetirement(
  record: RelayPtySourceDeliveryRecord,
  context: RequestContext,
  deliveries: Map<string, RelayPtySourceDeliveryRecord>,
  onCapacity: (id: string) => void
): void {
  record.recoveryCheckpointSourceEndSu = null
  record.recoveryEndSu = null
  context.onResponseSettled!(() => {
    if (deliveries.get(record.identity.id) !== record) {
      return
    }
    deliveries.delete(record.identity.id)
    onCapacity(record.identity.id)
  })
}

export function pendingPtySourceRecoveryResult(
  record: RelayPtySourceDeliveryRecord
): PtySourceRecoveryResult {
  if (record.recoveryCheckpointSourceEndSu === null || record.recoveryEndSu === null) {
    return Object.freeze({ status: 'restoreRequired', reason: 'checkpointUnavailable' })
  }
  return Object.freeze({
    status: 'pending',
    clientGeneration: record.identity.clientGeneration,
    ownerGeneration: record.identity.ownerGeneration,
    ptyIncarnation: record.identity.ptyIncarnation,
    deliveryToken: record.identity.deliveryToken,
    checkpointSourceEndSu: record.recoveryCheckpointSourceEndSu,
    recoveryEndSu: record.recoveryEndSu
  })
}

export function samePtySourceRecoveryRequest(
  expected: PtySourceRecoveryCheckpoint,
  received: PtySourceRecoveryRequest | undefined
): boolean {
  return (
    received?.status === 'checkpoint' &&
    received.deliveryToken === expected.deliveryToken &&
    received.clientGeneration === expected.clientGeneration &&
    received.ownerGeneration === expected.ownerGeneration &&
    received.ptyIncarnation === expected.ptyIncarnation &&
    received.acceptedSourceEndSu === expected.acceptedSourceEndSu
  )
}
