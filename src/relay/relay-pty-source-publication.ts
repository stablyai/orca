import type { PtySourceDeliveryIdentity } from '../shared/pty-source-credit-contract'
import type {
  PtySourceRecoveryRequest,
  PtySourceRecoveryResult
} from '../shared/pty-source-recovery-contract'
import type { PtySourceReceivingActivation } from '../shared/pty-source-receiving-activation'
import {
  createPtySourceReceivingActivation,
  createPtySourceDeliveryRecord,
  activePtySourceReceivingActivation,
  pendingPtySourceRecoveryResult,
  boundedPtyRecoveryEnd,
  samePtySourceRecoveryRequest
} from './relay-pty-source-activation'
import {
  RelayPtySourceSendScheduler,
  type RelayPtySourceDeliveryRecord,
  type RelayPtySourcePublicationCounters
} from './relay-pty-source-send-scheduler'
import {
  createActivationSettlementRegistrar,
  publishPtySourceRestoreRequired,
  requirePtySourceRestore
} from './relay-pty-source-publication-recovery'
import {
  RelayPtySourceLegacyExitIndex,
  sealAndPublishTrackedPtySourceExit,
  settleTrackedPtySourceExit,
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
import { RelayPtyOwnershipTransferSourceResolver } from './relay-pty-ownership-transfer-source-resolution'
import {
  bindRelayPtySourceDeliveryRetirement,
  bindRelayPtyCoveredSourceRetirement
} from './relay-pty-source-delivery-retirement'

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
  readonly ownershipTransfer: RelayPtyOwnershipTransferSourceResolver
  readonly prepareOwnershipTransferRetirement: ReturnType<
    typeof bindRelayPtySourceDeliveryRetirement
  >
  readonly prepareCoveredOwnershipTransferRetirement: ReturnType<
    typeof bindRelayPtyCoveredSourceRetirement
  >

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
    this.ownershipTransfer = new RelayPtyOwnershipTransferSourceResolver(
      this.deliveries,
      this.session
    )
    this.prepareOwnershipTransferRetirement = bindRelayPtySourceDeliveryRetirement(
      this.deliveries,
      this.session,
      this.ownershipTransfer
    )
    this.prepareCoveredOwnershipTransferRetirement = bindRelayPtyCoveredSourceRetirement(
      this.deliveries,
      this.session,
      this.ownershipTransfer
    )
    this.registerSettlement = createActivationSettlementRegistrar(
      this.deliveries,
      this.session,
      this.sender,
      this.onCapacity
    )
  }

  private readonly sender: RelayPtySourceSendScheduler

  private readonly registerSettlement: ReturnType<typeof createActivationSettlementRegistrar>

  activate(
    id: string,
    ptyIncarnation: string,
    context: RequestContext | undefined,
    recovery?: PtySourceRecoveryRequest
  ): false | 'opened' | 'rotated' | 'existing' | PtySourceRecoveryResult {
    let current = this.deliveries.get(id)
    // A superseded request must neither release nor cancel its replacement's delivery.
    const owned = current?.clientId === context?.clientId ? current : undefined
    if (!context?.onResponseSettled) {
      this.sender.releaseRotationFence(owned)
      return false
    }
    const mode = this.session.deliveryMode(context.clientId)
    if (mode === 'unadmitted' || mode === 'subscriber') {
      this.sender.releaseRotationFence(owned)
      return false
    }
    if (mode === 'legacy-owner') {
      if (owned) {
        this.session.cancelDelivery(owned.identity, 'source-credit-disabled')
        this.sender.wakeSendWaiters(owned)
        this.deliveries.delete(id)
        this.onCapacity(id)
      }
      return false
    }
    if (
      current?.clientId === context.clientId &&
      !current.restoreRequired &&
      current.sourceExitState !== 'pending' &&
      ptySourceDeliveryClosed(this.session, current.identity)
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
          return publishPtySourceRestoreRequired({
            id,
            context,
            reason: 'checkpointUnavailable',
            dispatcher: this.dispatcher,
            onCapacity: this.onCapacity
          })
        }
        this.registerSettlement(id, current, context)
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
      return publishPtySourceRestoreRequired({
        id,
        context,
        reason: 'deliveryUnavailable',
        dispatcher: this.dispatcher,
        onCapacity: this.onCapacity
      })
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
          return requirePtySourceRestore({
            id,
            current,
            context,
            reason: 'checkpointUnavailable',
            session: this.session,
            sender: this.sender,
            deliveries: this.deliveries,
            dispatcher: this.dispatcher,
            onCapacity: this.onCapacity
          })
        }
        const rotation = this.session.rotateDelivery(
          current.identity,
          context.clientId,
          recovery.acceptedSourceEndSu
        )
        identity = rotation.identity
        displayEnd = current.displayEnd
        recoveryCheckpointSourceEndSu = recovery.acceptedSourceEndSu
        recoveryEndSu = boundedPtyRecoveryEnd(this.session.sourceDeliverySnapshot(identity))
        recoveryWasSealed = snapshot.state === 'sealed-unsettled'
        this.counters.rotated++
      } catch (error) {
        return requirePtySourceRestore({
          id,
          current,
          context,
          reason: error instanceof Error ? error.message : 'invalidCheckpoint',
          session: this.session,
          sender: this.sender,
          deliveries: this.deliveries,
          dispatcher: this.dispatcher,
          onCapacity: this.onCapacity
        })
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
    const record = createPtySourceDeliveryRecord({
      clientId: context.clientId,
      identity,
      sourceActivation: createPtySourceReceivingActivation(
        identity,
        recoveryCheckpointSourceEndSu ?? activationSnapshot.sentEndSu,
        recoveryEndSu ?? activationSnapshot.receivedEndSu
      ),
      displayEnd,
      activationRecoveryRequest:
        recovery?.status === 'checkpoint' ? Object.freeze({ ...recovery }) : null,
      sealed: recoveryWasSealed,
      recoveryCheckpointSourceEndSu,
      recoveryEndSu
    })
    this.deliveries.set(id, record)
    this.registerSettlement(id, record, context)
    if (recoveryEndSu !== null && recoveryCheckpointSourceEndSu !== null) {
      return pendingPtySourceRecoveryResult(record)
    }
    return current ? 'rotated' : 'opened'
  }

  accepts = (id: string): boolean => this.deliveries.has(id)

  receivingActivation(id: string, clientId: number): PtySourceReceivingActivation | undefined {
    return activePtySourceReceivingActivation(this.deliveries.get(id), clientId)
  }

  waitForPendingSend = (id: string, timeoutMs?: number) =>
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
      if (ptySourceDeliveryClosed(this.session, record.identity)) {
        this.sender.wakeSendWaiters(record)
        this.deliveries.delete(id)
        // Defer until failed output is requeued, preventing exit from overtaking buffered data.
        queueMicrotask(() => this.onCapacity(id))
        return false
      }
      return false
    }
    if (!projectPtySourceOutputToLegacy(this.dispatcher, this.session, id, output, interactive)) {
      return false
    }
    this.sender.pump(record)
    return true
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
    return settleTrackedPtySourceExit(id, this.deliveries, this.legacyExits, this.sender)
  }

  getDebugSnapshot = () => this.sender.getDebugSnapshot()

  dispose = (): void => {
    this.legacyExits.clear()
    this.sender.dispose()
  }
}
