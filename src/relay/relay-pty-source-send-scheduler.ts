import type { PtySourceDeliveryIdentity } from '../shared/pty-source-credit-contract'
import type { PtySourceRecoveryCheckpoint } from '../shared/pty-source-recovery-contract'
import type { PtySourceReceivingActivation } from '../shared/pty-source-receiving-activation'
import type { RelayDispatcher, SinkWriteSettlement } from './dispatcher'
import {
  PTY_SOURCE_SCHEDULER_MAX_FRAMES,
  PTY_SOURCE_SCHEDULER_MAX_SU
} from './pty-source-credit-scheduler'
import type { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'
import { completePtySourceRecovery } from './relay-pty-source-recovery-completion'

export type RelayPtySourceDeliveryRecord = {
  clientId: number
  identity: PtySourceDeliveryIdentity
  sourceActivation: PtySourceReceivingActivation
  displayEnd: number
  activating: boolean
  activationRecoveryRequest: PtySourceRecoveryCheckpoint | null
  sealed: boolean
  legacyExitAccepted: boolean
  sourceExitState: 'idle' | 'pending' | 'published'
  sending: boolean
  turnFrames: number
  turnSourceSu: number
  turnScheduled: boolean
  sendWaiters: Set<() => void>
  recoveryCheckpointSourceEndSu: number | null
  recoveryEndSu: number | null
  recoveryCompletionPending: boolean
  restoreRequired: boolean
  rotationPending: boolean
}

export type RelayPtySourcePublicationCounters = {
  opened: number
  rotated: number
  appendDenied: number
  sendCommitted: number
  sendRolledBack: number
  exitCommitted: number
  exitRolledBack: number
}

const PTY_SOURCE_FRAME_MAX_SU = 16 * 1024

export function onceSinkSettlement(
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

export class RelayPtySourceSendScheduler {
  private readonly removeCompletionCapacityListener: () => void

  constructor(
    private readonly dispatcher: RelayDispatcher,
    private readonly session: SshPtyConsumerSessionAdapter,
    private readonly deliveries: Map<string, RelayPtySourceDeliveryRecord>,
    private readonly counters: RelayPtySourcePublicationCounters,
    private readonly onCapacity: (id: string) => void
  ) {
    this.removeCompletionCapacityListener = dispatcher.onLegacyPtyCapacity(() => {
      for (const record of deliveries.values()) {
        this.completeRecoveryIfReady(record)
      }
    })
  }

  async waitForPendingSend(id: string, timeoutMs = 5_000): Promise<boolean> {
    const record = this.deliveries.get(id)
    if (!record) {
      return true
    }
    record.rotationPending = true
    if (!record.sending) {
      return true
    }
    return new Promise<boolean>((resolve) => {
      const settle = (settled: boolean): void => {
        clearTimeout(timer)
        record.sendWaiters.delete(onSettled)
        resolve(settled)
      }
      const onSettled = (): void => settle(true)
      const timer = setTimeout(() => settle(false), timeoutMs)
      timer.unref?.()
      record.sendWaiters.add(onSettled)
    })
  }

  onCreditAvailable(id: string): void {
    const record = this.deliveries.get(id)
    if (!record || record.restoreRequired) {
      return
    }
    if (this.pruneClosed(id, record)) {
      this.onCapacity(id)
      return
    }
    this.pump(record)
    this.onCapacity(id)
  }

  getDebugSnapshot() {
    let active = 0
    let activating = 0
    let sealedUnsettled = 0
    let outstandingSourceUnits = 0
    for (const record of this.deliveries.values()) {
      const snapshot = this.session.sourceDeliverySnapshot(record.identity)
      outstandingSourceUnits += snapshot.sentEndSu - snapshot.creditedEndSu
      if (record.activating) {
        activating++
      } else if (record.sealed && snapshot.state !== 'closed') {
        sealedUnsettled++
      } else if (snapshot.state === 'active') {
        active++
      }
    }
    return Object.freeze({
      active,
      activating,
      sealedUnsettled,
      outstandingSourceUnits,
      ...this.counters
    })
  }

  dispose(): void {
    this.removeCompletionCapacityListener()
    for (const record of this.deliveries.values()) {
      this.session.cancelDelivery(record.identity, 'source-publication-disposed')
      this.wakeSendWaiters(record)
    }
    this.deliveries.clear()
  }

  pump(record: RelayPtySourceDeliveryRecord): void {
    if (
      record.activating ||
      record.sending ||
      record.turnScheduled ||
      record.restoreRequired ||
      record.rotationPending ||
      this.deliveries.get(record.identity.id) !== record
    ) {
      return
    }
    if (
      record.recoveryEndSu !== null &&
      this.session.sourceDeliverySnapshot(record.identity).sentEndSu >= record.recoveryEndSu
    ) {
      this.completeRecoveryIfReady(record)
      return
    }
    if (
      record.turnFrames >= PTY_SOURCE_SCHEDULER_MAX_FRAMES ||
      record.turnSourceSu >= PTY_SOURCE_SCHEDULER_MAX_SU
    ) {
      record.turnScheduled = true
      setImmediate(() => {
        record.turnScheduled = false
        record.turnFrames = 0
        record.turnSourceSu = 0
        if (this.deliveries.get(record.identity.id) !== record || record.restoreRequired) {
          return
        }
        this.pump(record)
        this.onCapacity(record.identity.id)
      })
      return
    }
    const snapshot = this.session.sourceDeliverySnapshot(record.identity)
    const encodedDataBudget = this.dispatcher.producerDataBudget(
      'pty.data',
      {
        id: record.identity.id,
        rawLength: PTY_SOURCE_FRAME_MAX_SU,
        transformed: false,
        deliveryToken: record.identity.deliveryToken,
        clientGeneration: record.identity.clientGeneration,
        ownerGeneration: record.identity.ownerGeneration,
        ptyIncarnation: record.identity.ptyIncarnation,
        sourceEndSu: snapshot.receivedEndSu,
        sourceLengthSu: PTY_SOURCE_FRAME_MAX_SU
      },
      record.clientId
    )
    const maxSourceSu = Math.min(
      PTY_SOURCE_FRAME_MAX_SU,
      Math.max(1, Math.floor(Math.max(0, encodedDataBudget - 32) / 6))
    )
    const reservation = this.session.reserveSourceSend(record.identity, maxSourceSu)
    if (!reservation) {
      return
    }
    record.sending = true
    const sourceLengthSu = reservation.span.sourceEndSu - reservation.span.sourceStartSu
    const settle = onceSinkSettlement((result) => {
      record.sending = false
      this.wakeSendWaiters(record)
      if (this.deliveries.get(record.identity.id) !== record || record.restoreRequired) {
        this.onCapacity(record.identity.id)
        return
      }
      if (result.ok) {
        this.session.commitSourceSend(reservation)
        record.turnFrames++
        record.turnSourceSu += sourceLengthSu
        this.counters.sendCommitted++
        this.completeRecoveryIfReady(record)
      } else {
        this.session.rollbackSourceSend(reservation)
        this.counters.sendRolledBack++
      }
      this.pruneClosed(record.identity.id, record)
      this.onCapacity(record.identity.id)
      if (result.ok && this.deliveries.get(record.identity.id) === record) {
        this.pump(record)
      }
    })
    const accepted = this.dispatcher.tryNotifyPtyDataToClient(
      record.clientId,
      {
        id: reservation.identity.id,
        data: reservation.span.data,
        rawLength: sourceLengthSu,
        transformed: reservation.span.transform.transformed,
        deliveryToken: reservation.identity.deliveryToken,
        clientGeneration: reservation.identity.clientGeneration,
        ownerGeneration: reservation.identity.ownerGeneration,
        ptyIncarnation: reservation.identity.ptyIncarnation,
        sourceEndSu: reservation.span.sourceEndSu,
        sourceLengthSu
      },
      settle
    )
    if (!accepted) {
      settle({ ok: false, error: new Error('PTY source publication was not admitted') })
    }
  }

  completeRecoveryIfReady(record: RelayPtySourceDeliveryRecord): void {
    completePtySourceRecovery({
      record,
      deliveries: this.deliveries,
      dispatcher: this.dispatcher,
      session: this.session,
      onCompleted: (id) => {
        this.onCapacity(id)
        if (this.deliveries.get(id) === record) {
          this.pump(record)
        }
      }
    })
  }

  pruneClosed(id: string, record: RelayPtySourceDeliveryRecord): boolean {
    if (this.session.sourceDeliverySnapshot(record.identity).state !== 'closed') {
      return false
    }
    if (this.deliveries.get(id) === record) {
      this.deliveries.delete(id)
    }
    return true
  }

  wakeSendWaiters(record: RelayPtySourceDeliveryRecord): void {
    for (const resolve of record.sendWaiters) {
      resolve()
    }
    record.sendWaiters.clear()
  }

  releaseRotationFence(record: RelayPtySourceDeliveryRecord | undefined): void {
    if (!record?.rotationPending) {
      return
    }
    record.rotationPending = false
    this.pump(record)
    this.onCapacity(record.identity.id)
  }
}
