import { randomUUID } from 'node:crypto'
import type { PtySourceDeliveryIdentity } from '../shared/pty-source-credit-contract'
import type {
  PtySourceRecoveryRequest,
  PtySourceRecoveryResult
} from '../shared/pty-source-recovery-contract'
import type { PtySourceReceivingActivation } from '../shared/pty-source-receiving-activation'
import {
  createPtySourceReceivingActivation,
  pendingPtySourceRecoveryResult,
  registerCanceledPtySourceRetirement,
  registerPtySourceActivationSettlement,
  samePtySourceRecoveryRequest
} from './relay-pty-source-activation'
import {
  RelayPtySourceSendScheduler,
  type RelayPtySourceDeliveryRecord,
  type RelayPtySourcePublicationCounters
} from './relay-pty-source-send-scheduler'
import { sealAndPublishPtySourceExit } from './relay-pty-source-exit-publication'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import type { RelayPtySourceOutput } from './relay-pty-source-output'
import type { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

export class RelayPtySourcePublication {
  private readonly deliveries = new Map<string, RelayPtySourceDeliveryRecord>()
  private readonly counters: RelayPtySourcePublicationCounters = {
    opened: 0,
    rotated: 0,
    appendDenied: 0,
    sendCommitted: 0,
    sendRolledBack: 0,
    exitCommitted: 0,
    exitRolledBack: 0
  }

  constructor(
    private readonly dispatcher: RelayDispatcher,
    private readonly session: SshPtyConsumerSessionAdapter,
    private readonly onCapacity: (id: string) => void
  ) {
    this.sender = new RelayPtySourceSendScheduler(
      dispatcher,
      session,
      this.deliveries,
      this.counters,
      onCapacity
    )
  }

  private readonly sender: RelayPtySourceSendScheduler

  activate(
    id: string,
    ptyIncarnation: string,
    context: RequestContext | undefined,
    recovery?: PtySourceRecoveryRequest
  ): false | 'opened' | 'rotated' | 'existing' | PtySourceRecoveryResult {
    if (!context?.onResponseSettled) {
      this.sender.releaseRotationFence(this.deliveries.get(id))
      return false
    }
    const mode = this.session.deliveryMode(context.clientId)
    const current = this.deliveries.get(id)
    if (mode === 'subscriber') {
      this.sender.releaseRotationFence(current)
      return false
    }
    if (mode === 'legacy-owner') {
      if (current) {
        this.session.cancelDelivery(current.identity, 'source-credit-disabled')
        this.deliveries.delete(id)
        this.onCapacity(id)
      }
      return false
    }
    if (current?.clientId === context.clientId) {
      this.sender.releaseRotationFence(current)
      if (current.activating && current.activationRecoveryRequest) {
        if (!samePtySourceRecoveryRequest(current.activationRecoveryRequest, recovery)) {
          return this.publishRestoreRequired(id, context, 'checkpointUnavailable')
        }
        this.registerActivationSettlement(id, current, context)
        return pendingPtySourceRecoveryResult(current)
      }
      return 'existing'
    }
    let identity: PtySourceDeliveryIdentity | null = null
    let displayEnd = 0
    let recoveryCheckpointSourceEndSu: number | null = null
    let recoveryEndSu: number | null = null
    let recoveryWasSealed = false
    if (!current && recovery) {
      return this.publishRestoreRequired(id, context, 'deliveryUnavailable')
    }
    if (current) {
      try {
        const snapshot = this.session.sourceDeliverySnapshot(current.identity)
        if (
          snapshot.state === 'closed' ||
          snapshot.state === 'closing' ||
          recovery?.status !== 'checkpoint' ||
          recovery.deliveryToken !== current.identity.deliveryToken ||
          recovery.clientGeneration !== current.identity.clientGeneration ||
          recovery.ownerGeneration !== current.identity.ownerGeneration ||
          recovery.ptyIncarnation !== current.identity.ptyIncarnation
        ) {
          return this.requireRestore(id, current, context, 'checkpointUnavailable')
        }
        const rotation = this.session.rotateDelivery(
          current.identity,
          context.clientId,
          recovery.acceptedSourceEndSu
        )
        identity = rotation.identity
        displayEnd = current.displayEnd
        recoveryCheckpointSourceEndSu = recovery.acceptedSourceEndSu
        recoveryEndSu = snapshot.receivedEndSu
        recoveryWasSealed = snapshot.state === 'sealed-unsettled'
        this.counters.rotated++
      } catch (error) {
        return this.requireRestore(
          id,
          current,
          context,
          error instanceof Error ? error.message : 'invalidCheckpoint'
        )
      }
    }
    identity ??= this.session.openDelivery(context.clientId, id, ptyIncarnation)
    if (!identity) {
      return false
    }
    if (!current || identity !== current.identity) {
      this.counters.opened++
    }
    const activationSnapshot = this.session.sourceDeliverySnapshot(identity)
    const activationCheckpointSourceEndSu =
      recoveryCheckpointSourceEndSu ?? activationSnapshot.sentEndSu
    const activationRecoveryEndSu = recoveryEndSu ?? activationSnapshot.receivedEndSu
    const record: RelayPtySourceDeliveryRecord = {
      clientId: context.clientId,
      identity,
      sourceActivation: createPtySourceReceivingActivation(
        identity,
        activationCheckpointSourceEndSu,
        activationRecoveryEndSu
      ),
      displayEnd,
      activating: true,
      activationRecoveryRequest:
        recovery?.status === 'checkpoint' ? Object.freeze({ ...recovery }) : null,
      sealed: recoveryWasSealed,
      legacyExitAccepted: false,
      sourceExitState: 'idle',
      sending: false,
      turnFrames: 0,
      turnSourceSu: 0,
      turnScheduled: false,
      sendWaiters: new Set(),
      recoveryCheckpointSourceEndSu,
      recoveryEndSu,
      recoveryCompletionPending: false,
      restoreRequired: false,
      rotationPending: false
    }
    this.deliveries.set(id, record)
    this.registerActivationSettlement(id, record, context)
    if (recoveryEndSu !== null && recoveryCheckpointSourceEndSu !== null) {
      return pendingPtySourceRecoveryResult(record)
    }
    return current ? 'rotated' : 'opened'
  }

  accepts = (id: string): boolean => this.deliveries.has(id)

  receivingActivation(id: string, clientId: number): PtySourceReceivingActivation | undefined {
    const record = this.deliveries.get(id)
    return record?.clientId === clientId && !record.restoreRequired
      ? record.sourceActivation
      : undefined
  }

  waitForPendingSend = (id: string, timeoutMs = 5_000): Promise<boolean> =>
    this.sender.waitForPendingSend(id, timeoutMs)

  publish(id: string, output: RelayPtySourceOutput, interactive: boolean): boolean {
    const record = this.deliveries.get(id)
    if (
      !record ||
      record.sealed ||
      record.recoveryEndSu !== null ||
      record.restoreRequired ||
      record.rotationPending
    ) {
      return false
    }
    if (!output.sourceAccepted) {
      const rawLength = output.rawLength ?? output.data.length
      output.sourceSpanId ??= randomUUID()
      try {
        this.session.appendSource(record.identity, {
          spanId: output.sourceSpanId,
          data: output.data,
          displayStart: record.displayEnd,
          displayEnd: record.displayEnd + output.data.length,
          splittable: output.transformed !== true,
          transform: {
            transformed: output.transformed === true,
            rawLengthSu: rawLength,
            scalarSafe: output.transformed !== true
          }
        })
      } catch {
        this.counters.appendDenied++
        return false
      }
      output.sourceAccepted = true
      record.displayEnd += output.data.length
    }
    if (
      !this.dispatcher.projectPtyDataToMatchingClients(
        (clientId) => this.session.deliveryMode(clientId) !== 'source-owner',
        {
          id,
          data: output.data,
          ...(output.seq === undefined ? {} : { seq: output.seq }),
          ...(output.rawLength === undefined ? {} : { rawLength: output.rawLength }),
          ...(output.transformed ? { transformed: true } : {})
        },
        { interactive }
      )
    ) {
      return false
    }
    this.sender.pump(record)
    return true
  }

  sealAndPublishExit(params: { id: string; code: number; incarnationId: string }): boolean {
    const record = this.deliveries.get(params.id)
    if (!record) {
      return false
    }
    return sealAndPublishPtySourceExit({
      params,
      record,
      deliveries: this.deliveries,
      dispatcher: this.dispatcher,
      session: this.session,
      sender: this.sender,
      counters: this.counters,
      onCapacity: this.onCapacity
    })
  }

  onCreditAvailable = (id: string): void => this.sender.onCreditAvailable(id)

  exitPublicationSettled(id: string): boolean {
    const record = this.deliveries.get(id)
    if (!record || record.sourceExitState !== 'published') {
      return false
    }
    this.sender.pruneClosed(id, record)
    return true
  }

  getDebugSnapshot = () => this.sender.getDebugSnapshot()

  dispose = (): void => this.sender.dispose()

  private registerActivationSettlement(
    id: string,
    record: RelayPtySourceDeliveryRecord,
    context: RequestContext
  ): void {
    registerPtySourceActivationSettlement({
      id,
      record,
      context,
      deliveries: this.deliveries,
      session: this.session,
      sender: this.sender,
      onCapacity: this.onCapacity
    })
  }

  private requireRestore(
    id: string,
    current: RelayPtySourceDeliveryRecord,
    context: RequestContext,
    reason: string
  ): Readonly<{ status: 'restoreRequired'; reason: string }> {
    this.session.cancelDelivery(current.identity, `recovery-${reason}`)
    current.restoreRequired = true
    current.activating = false
    this.sender.wakeSendWaiters(current)
    registerCanceledPtySourceRetirement(current, context, this.deliveries, this.onCapacity)
    return this.publishRestoreRequired(id, context, reason)
  }

  private publishRestoreRequired(
    id: string,
    context: RequestContext,
    reason: string
  ): Readonly<{ status: 'restoreRequired'; reason: string }> {
    const result = Object.freeze({ status: 'restoreRequired' as const, reason })
    context.onResponseSettled?.((settlement) => {
      if (settlement.ok) {
        this.dispatcher.notifyClient(context.clientId, 'pty.restoreRequired', { id, reason })
      }
    })
    this.onCapacity(id)
    return result
  }
}
