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
import {
  RelayPtySourceLegacyExitIndex,
  sealAndPublishTrackedPtySourceExit,
  type PtyExitParams
} from './relay-pty-source-exit-publication'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import {
  appendPtySourceOutput,
  projectPtySourceOutputToLegacy,
  ptySourceDeliveryClosed,
  type RelayPtySourceOutput
} from './relay-pty-source-output'
import type { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

export class RelayPtySourcePublication {
  private readonly deliveries = new Map<string, RelayPtySourceDeliveryRecord>()
  private readonly legacyExits = new RelayPtySourceLegacyExitIndex()
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
    let current = this.deliveries.get(id)
    if (mode === 'subscriber') {
      this.sender.releaseRotationFence(current)
      return false
    }
    if (mode === 'legacy-owner') {
      if (current) {
        this.session.cancelDelivery(current.identity, 'source-credit-disabled')
        this.sender.wakeSendWaiters(current)
        this.deliveries.delete(id)
        this.onCapacity(id)
      }
      return false
    }
    if (
      current?.clientId === context.clientId &&
      !current.restoreRequired &&
      current.sourceExitState !== 'pending' &&
      this.deliveryClosedUnderRecord(current)
    ) {
      // Why: a canceled delivery can never resume as 'existing'; retire it so re-attach opens fresh.
      this.sender.wakeSendWaiters(current)
      this.deliveries.delete(id)
      this.onCapacity(id)
      current = undefined
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
    if (!output.sourceAccepted && !appendPtySourceOutput(this.session, record, output)) {
      this.counters.appendDenied++
      if (this.deliveryClosedUnderRecord(record)) {
        this.sender.wakeSendWaiters(record)
        this.deliveries.delete(id)
        // Why: deferred — publish() can run inside flushPendingOutput's captured-queue drain,
        // where pendingOutputByPty is transiently empty; a synchronous capacity callback would
        // publish pty.exit ahead of still-buffered output. By microtask time the failed chunk
        // has been re-queued (flushPtyOutput re-sets the queue synchronously on failure).
        queueMicrotask(() => this.onCapacity(id))
        return false
      }
      return false
    }
    const { dispatcher, session, sender } = this
    const projected = projectPtySourceOutputToLegacy(dispatcher, session, id, output, interactive)
    // Why: the span is already in the source ledger, so a stalled legacy subscriber must not also
    // starve the flow-controlled owner — only the PTY pause is shared.
    sender.pump(record)
    return projected
  }

  sealAndPublishExit = (params: PtyExitParams): boolean =>
    sealAndPublishTrackedPtySourceExit({
      params,
      legacyExits: this.legacyExits,
      deliveries: this.deliveries,
      dispatcher: this.dispatcher,
      session: this.session,
      sender: this.sender,
      counters: this.counters,
      onCapacity: this.onCapacity
    })

  /** Returns null when the caller should fall back to its own legacy exit broadcast. */
  publishExitAfterRetire = (params: PtyExitParams): boolean | null =>
    this.legacyExits.publishAfterRetire(params, this.dispatcher, this.session)

  onCreditAvailable = (id: string): void => this.sender.onCreditAvailable(id)

  exitPublicationSettled(id: string): boolean {
    const record = this.deliveries.get(id)
    if (!record || record.sourceExitState !== 'published') {
      return false
    }
    // Why: owner and legacy subscribers both hold this exit now, so the index row would otherwise
    // outlive the pty for the daemon's lifetime and re-publish on any later fallback.
    this.legacyExits.forget(id)
    this.sender.pruneClosed(id, record)
    return true
  }

  getDebugSnapshot = () => this.sender.getDebugSnapshot()

  dispose = (): void => {
    this.legacyExits.clear()
    this.sender.dispose()
  }

  private deliveryClosedUnderRecord(record: RelayPtySourceDeliveryRecord): boolean {
    return ptySourceDeliveryClosed(this.session, record.identity)
  }

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
