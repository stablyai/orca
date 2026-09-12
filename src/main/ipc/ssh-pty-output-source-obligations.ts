import {
  ptySourceDeliveryKey,
  samePtySourceDelivery,
  type PtySourceDeliveryIdentity,
  type PtySourceSpan
} from '../../shared/pty-source-credit-contract'
import type { RemoteTerminalSourceRangeConsumerHooks } from '../runtime/remote-terminal-source-range-consumer'
import type { DesktopProjectionSpan } from './ssh-pty-legacy-projection'
import type {
  SshPtyOutputDataEvent,
  SshPtyOutputExitEvent,
  SshPtyOutputIntakeDependencies,
  SshPtySourceCancellationProof,
  SshPtySourceCancellationRequest
} from './ssh-pty-output-intake-contract'
import { SshPtyRemoteSourceRangeConsumers } from './ssh-pty-remote-source-range-consumers'
import type {
  SshPtySourceAdmissionReservation,
  SshPtySourceConsumerId
} from './ssh-pty-source-obligation-contract'
import { SshPtySourceObligationCoordinator } from './ssh-pty-source-obligation-coordinator'
import {
  sourceAcceptedCheckpoint,
  requireSourceCheckpointIdentity,
  type SshPtyAcceptedSourceCheckpoint
} from './ssh-pty-source-checkpoint'
export type { SshPtyAcceptedSourceCheckpoint } from './ssh-pty-source-checkpoint'
import {
  SshPtyOwnershipTransferObligations,
  type SshPtyOwnershipTransferSourceRange
} from './ssh-pty-ownership-transfer-obligations'

export type { SshPtyOwnershipTransferSourceRange } from './ssh-pty-ownership-transfer-obligations'

export type SshPtyOutputSourceReservation = Readonly<{
  admission: SshPtySourceAdmissionReservation
  span: PtySourceSpan
}>

export type SshPtySourceCancellationProofCommit = Readonly<{
  identity: PtySourceDeliveryIdentity
  proof: SshPtySourceCancellationProof
}>

export class SshPtyOutputSourceObligations {
  private readonly coordinator: SshPtySourceObligationCoordinator
  private readonly remoteConsumers: SshPtyRemoteSourceRangeConsumers
  private readonly ownershipTransferObligations: SshPtyOwnershipTransferObligations
  private readonly openedTokens = new Set<string>()
  // Why: fence/recovery consumers key checkpoints by app pty id, but the wire
  // ACK path needs the relay id kept on identity.id — record both.
  private readonly identityByPty = new Map<
    string,
    Readonly<{ appPtyId: string; identity: PtySourceDeliveryIdentity }>
  >()

  constructor(
    publish: SshPtyOutputDataEventPublisher | undefined,
    options: { ownershipTransferOutputEnabled?: boolean } = {}
  ) {
    this.coordinator = new SshPtySourceObligationCoordinator({
      onTokenClosed: (identity) => this.removeIdentity(identity),
      publish:
        publish ??
        ((_providerGeneration, _batch, onSettled) =>
          onSettled({ ok: false, error: new Error('SSH PTY source ACK publisher unavailable') }))
    })
    this.remoteConsumers = new SshPtyRemoteSourceRangeConsumers(this.coordinator)
    this.ownershipTransferObligations = new SshPtyOwnershipTransferObligations(
      this.coordinator,
      options.ownershipTransferOutputEnabled === true
    )
  }

  get remoteHooks(): RemoteTerminalSourceRangeConsumerHooks {
    return this.remoteConsumers.hooks
  }
  reserve(
    event: SshPtyOutputDataEvent,
    projection: DesktopProjectionSpan
  ): SshPtyOutputSourceReservation {
    const span = this.toSourceSpan(event, projection)
    const identity = span
    const tokenKey = ptySourceDeliveryKey(identity)
    if (!this.openedTokens.has(tokenKey)) {
      this.coordinator.open(identity, span.sourceStartSu)
      this.openedTokens.add(tokenKey)
      this.identityByPty.set(this.ptyKey(event), Object.freeze({ appPtyId: event.id, identity }))
    }
    const requiredConsumers: SshPtySourceConsumerId[] = [
      'model',
      'desktop',
      ...this.remoteConsumers.requiredConsumers(event.id)
    ]
    const transfer = event.source?.ownershipTransfer
    if (transfer && this.ownershipTransferObligations.isEnabled()) {
      requiredConsumers.push(`ownership-transfer:${transfer.bridgeId}`)
    }
    return Object.freeze({
      span,
      admission: this.coordinator.reserve(identity, span, requiredConsumers)
    })
  }
  commit(
    reservation: SshPtyOutputSourceReservation,
    ptyId: string,
    modelSequenceEnd: number
  ): void {
    this.coordinator.commit(reservation.admission)
    this.remoteConsumers.trackSpan(
      ptyId,
      reservation.span.spanId,
      reservation.admission.requiredConsumers,
      modelSequenceEnd
    )
  }
  settlePendingOwnershipTransfer(span: PtySourceSpan): void {
    this.ownershipTransferObligations.afterCommit(span)
  }
  rollback(reservation: SshPtyOutputSourceReservation): boolean {
    return (
      this.coordinator.rollback(reservation.admission) ||
      this.coordinator.rollbackCommitted(reservation.admission)
    )
  }
  settleModel(span: PtySourceSpan): void {
    this.coordinator.settle({
      identity: span,
      spanId: span.spanId,
      consumer: 'model',
      reason: 'model-accepted'
    })
  }
  settleDesktop(span: DesktopProjectionSpan, reason: string): void {
    this.coordinator.settle({
      identity: span,
      spanId: span.spanId,
      consumer: 'desktop',
      reason
    })
  }
  settleOwnershipTransfer(range: SshPtyOwnershipTransferSourceRange): void {
    this.ownershipTransferObligations.settle(range)
  }
  transferDesktop(span: DesktopProjectionSpan, reason: string): void {
    const transition = {
      identity: span,
      spanId: span.spanId,
      consumer: 'desktop' as const,
      reason
    }
    if (this.coordinator.beginTransfer(transition, 'model')) {
      this.coordinator.commitTransfer(transition)
    }
  }
  sealPty(event: SshPtyOutputExitEvent): void {
    const identity = this.identityByPty.get(this.ptyKey(event))?.identity
    if (identity) {
      this.coordinator.seal(identity)
    }
  }
  markExitPublished(event: SshPtyOutputExitEvent): void {
    const identity = this.identityByPty.get(this.ptyKey(event))?.identity
    if (identity) {
      this.coordinator.markExitPublished(identity)
    }
  }
  whenPtyTerminal(event: SshPtyOutputExitEvent): Promise<void> {
    const identity = this.identityByPty.get(this.ptyKey(event))?.identity
    return identity ? this.coordinator.whenTerminal(identity) : Promise.resolve()
  }
  async requestPtyCancellationProof(
    event: SshPtyOutputExitEvent,
    cancel: (request: SshPtySourceCancellationRequest) => Promise<SshPtySourceCancellationProof>
  ): Promise<SshPtySourceCancellationProofCommit | null> {
    const identity = this.identityByPty.get(this.ptyKey(event))?.identity
    if (!identity) {
      return null
    }
    const request = this.coordinator.beginExitTimeout(identity)
    const proof = await cancel(request)
    return Object.freeze({ identity, proof })
  }
  commitPtyCancellationProof(commit: SshPtySourceCancellationProofCommit): void {
    this.coordinator.applyCancellationProof(commit.identity, commit.proof)
  }
  applyCancellationProof(
    event: SshPtyOutputExitEvent,
    proof: SshPtySourceCancellationProof
  ): boolean {
    const identity = this.identityByPty.get(this.ptyKey(event))?.identity
    if (!identity) {
      return false
    }
    this.coordinator.applyCancellationProof(identity, proof)
    return true
  }
  applyRecoveryCancellationProof(
    event: SshPtyOutputExitEvent,
    proof: SshPtySourceCancellationProof
  ): void {
    const identity = this.identityByPty.get(this.ptyKey(event))?.identity
    if (identity) {
      this.coordinator.applyRecoveryCancellationProof(identity, proof)
    }
  }
  closeGeneration(providerGeneration: number, reason: string): void {
    this.ownershipTransferObligations.closeGeneration(providerGeneration)
    this.remoteConsumers.closeGeneration(providerGeneration, reason)
    this.coordinator.closeGeneration(providerGeneration, reason)
    const prefix = `${providerGeneration}\0`
    for (const key of this.openedTokens) {
      if (key.startsWith(prefix)) {
        this.openedTokens.delete(key)
      }
    }
    for (const [key, record] of this.identityByPty) {
      if (record.identity.providerGeneration === providerGeneration) {
        this.identityByPty.delete(key)
      }
    }
  }
  acceptedCheckpoints(providerGeneration: number): readonly SshPtyAcceptedSourceCheckpoint[] {
    const checkpoints: SshPtyAcceptedSourceCheckpoint[] = []
    for (const record of this.identityByPty.values()) {
      if (record.identity.providerGeneration !== providerGeneration) {
        continue
      }
      checkpoints.push(
        sourceAcceptedCheckpoint(record, this.coordinator.modelAcceptedEnd(record.identity))
      )
    }
    return Object.freeze(checkpoints)
  }
  acceptedCheckpoint(key: {
    ptyId: string
    providerGeneration: number
  }): SshPtyAcceptedSourceCheckpoint | null {
    return (
      this.acceptedCheckpoints(key.providerGeneration).find(
        (checkpoint) => checkpoint.id === key.ptyId
      ) ?? null
    )
  }
  requireLiveSettlement(checkpoint: SshPtyAcceptedSourceCheckpoint) {
    const identity = requireSourceCheckpointIdentity(
      this.identityByPty.get(this.ptyKey(checkpoint)),
      checkpoint
    )
    return this.coordinator.requireLiveSettlement(identity, checkpoint.acceptedSourceEndSu)
  }
  dispose(): void {
    this.ownershipTransferObligations.dispose()
    this.coordinator.dispose()
  }
  getDebugSnapshot(): Readonly<{
    openedTokens: number
    ptyIdentities: number
    pendingOwnershipTransferSettlements: number
  }> {
    return Object.freeze({
      openedTokens: this.openedTokens.size,
      ptyIdentities: this.identityByPty.size,
      pendingOwnershipTransferSettlements: this.ownershipTransferObligations.pendingCount()
    })
  }
  private toSourceSpan(
    event: SshPtyOutputDataEvent,
    projection: DesktopProjectionSpan
  ): PtySourceSpan {
    return Object.freeze({
      id: projection.id,
      providerGeneration: event.providerGeneration,
      clientGeneration: projection.clientGeneration,
      ownerGeneration: projection.ownerGeneration,
      ptyIncarnation: event.ptyIncarnation,
      deliveryToken: projection.deliveryToken,
      spanId: projection.spanId,
      sourceStartSu: projection.sourceStartSu,
      sourceEndSu: projection.sourceEndSu,
      displayStart: projection.displayStart,
      displayEnd: projection.displayEnd,
      splittable: projection.splittable,
      transform: projection.transform,
      ...(event.source?.ownershipTransfer
        ? { ownershipTransfer: event.source.ownershipTransfer }
        : {}),
      data: event.data
    })
  }

  private ptyKey(
    event: Pick<SshPtyOutputDataEvent, 'id' | 'providerGeneration' | 'ptyIncarnation'>
  ): string {
    return `${event.providerGeneration}\0${event.id}\0${event.ptyIncarnation}`
  }

  private removeIdentity(identity: PtySourceDeliveryIdentity): void {
    this.openedTokens.delete(ptySourceDeliveryKey(identity))
    for (const [key, record] of this.identityByPty) {
      if (samePtySourceDelivery(record.identity, identity)) {
        this.identityByPty.delete(key)
      }
    }
  }
}

type SshPtyOutputDataEventPublisher = NonNullable<
  SshPtyOutputIntakeDependencies['publishSourceAck']
>
