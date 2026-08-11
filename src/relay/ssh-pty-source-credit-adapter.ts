import { randomUUID } from 'node:crypto'
import {
  MAX_PTY_ACK_ENTRIES,
  type PtySourceDeliveryCancellation,
  type PtySourceDeliveryIdentity,
  type PtySourceDeliverySnapshot,
  type PtySourceSpan,
  type PtySourceTransform
} from '../shared/pty-source-credit-contract'
import {
  PTY_CONSUMER_OWNER_GRACE_MS,
  type PtyConsumerSessionGrant
} from '../shared/pty-consumer-session'
import {
  ptySourceCancellationResult,
  RecentPtySourceCancellationIndex
} from './pty-source-cancellation-index'
import { notifyPtySourceCreditAvailable } from './pty-source-credit-availability-notice'
import { ownedPtySourceDelivery } from './pty-source-delivery-ownership'
import {
  RelayPtySourceCreditLedger,
  type PtySourceSendReservation
} from './pty-source-credit-ledger'

export class SshPtySourceCreditAdapter {
  private readonly sourceCredit = new RelayPtySourceCreditLedger()
  private readonly identityByToken = new Map<string, PtySourceDeliveryIdentity>()
  private readonly graceTimers = new Map<number, ReturnType<typeof setTimeout>>()
  private readonly recentCancellations = new RecentPtySourceCancellationIndex()
  private readonly relayProviderGeneration = 1
  private disposed = false

  constructor(
    private readonly publishCancellation?: (proof: PtySourceDeliveryCancellation) => void,
    private readonly onCreditAvailable?: (id: string) => void
  ) {}

  open(
    grant: Readonly<PtyConsumerSessionGrant> | null,
    id: string,
    ptyIncarnation: string,
    checkpointSourceEndSu = 0
  ): PtySourceDeliveryIdentity | null {
    if (this.disposed) {
      throw new Error('SSH PTY source credit adapter is disposed')
    }
    const flow = grant?.capabilities?.outputFlowControl
    if (
      !grant ||
      grant.role !== 'session-owner' ||
      !grant.ownerGeneration ||
      !flow ||
      !id ||
      !ptyIncarnation
    ) {
      return null
    }
    const identity = Object.freeze({
      id,
      providerGeneration: this.relayProviderGeneration,
      clientGeneration: grant.clientGeneration,
      ownerGeneration: grant.ownerGeneration,
      ptyIncarnation,
      deliveryToken: randomUUID()
    })
    this.sourceCredit.open(identity, flow.windowSu, checkpointSourceEndSu)
    this.identityByToken.set(identity.deliveryToken, identity)
    return identity
  }

  rotate(
    oldIdentity: PtySourceDeliveryIdentity,
    grant: Readonly<PtyConsumerSessionGrant> | null,
    acceptedSourceEndSu: number
  ) {
    const flow = grant?.capabilities?.outputFlowControl
    if (!grant || !flow || !grant.ownerGeneration || grant.role !== 'session-owner') {
      throw new Error('PTY source delivery recovery requires the active negotiated owner')
    }
    const replacement = Object.freeze({
      ...oldIdentity,
      clientGeneration: grant.clientGeneration,
      ownerGeneration: grant.ownerGeneration,
      deliveryToken: randomUUID()
    })
    const rotation = this.sourceCredit.rotate(
      oldIdentity,
      replacement,
      acceptedSourceEndSu,
      flow.windowSu
    )
    this.identityByToken.delete(oldIdentity.deliveryToken)
    this.recentCancellations.remember(rotation.cancellation)
    this.publishCancellation?.(rotation.cancellation)
    this.identityByToken.set(replacement.deliveryToken, replacement)
    this.clearGraceWhenSettled(oldIdentity.ownerGeneration)
    return Object.freeze({ identity: replacement, ...rotation })
  }

  append(
    identity: PtySourceDeliveryIdentity,
    input: Readonly<{
      spanId: string
      data: string
      displayStart: number
      displayEnd: number
      splittable: boolean
      transform: PtySourceTransform
    }>
  ): PtySourceSpan {
    return this.sourceCredit.append(identity, input)
  }

  reserveSend(
    identity: PtySourceDeliveryIdentity,
    maxSourceSu?: number
  ): PtySourceSendReservation | null {
    return this.sourceCredit.reserveNextSend(identity, maxSourceSu)
  }

  commitSend(reservation: PtySourceSendReservation): void {
    this.sourceCredit.commitSend(reservation)
  }

  rollbackSend(reservation: PtySourceSendReservation): void {
    this.sourceCredit.rollbackSend(reservation)
  }

  seal(identity: PtySourceDeliveryIdentity): void {
    this.sourceCredit.seal(identity)
  }

  settleExit(
    identity: PtySourceDeliveryIdentity,
    result: { ok: true } | { ok: false; error: Error }
  ): void {
    this.sourceCredit.settleExitPublication(identity, result)
    this.pruneClosed(identity.deliveryToken, identity)
  }

  snapshot(identity: PtySourceDeliveryIdentity): PtySourceDeliverySnapshot {
    return this.sourceCredit.snapshot(identity)
  }

  snapshotIfKnown(identity: PtySourceDeliveryIdentity): PtySourceDeliverySnapshot | null {
    return this.sourceCredit.snapshotIfKnown(identity)
  }

  acknowledge(
    params: Record<string, unknown>,
    grant: Readonly<PtyConsumerSessionGrant> | null
  ): void {
    const acknowledgements = params.acknowledgements
    if (
      !grant?.capabilities?.outputFlowControl ||
      !Array.isArray(acknowledgements) ||
      acknowledgements.length > MAX_PTY_ACK_ENTRIES
    ) {
      return
    }
    for (const raw of acknowledgements) {
      if (typeof raw !== 'object' || raw === null) {
        continue
      }
      const candidate = raw as Record<string, unknown>
      const token = typeof candidate.deliveryToken === 'string' ? candidate.deliveryToken : ''
      const identity = token.length > 0 ? this.identityByToken.get(token) : undefined
      if (!identity || identity.clientGeneration !== grant.clientGeneration) {
        continue
      }
      try {
        const result = this.sourceCredit.acknowledge(identity, {
          id: String(candidate.id ?? ''),
          clientGeneration: Number(candidate.clientGeneration),
          ownerGeneration: Number(candidate.ownerGeneration),
          deliveryToken: String(candidate.deliveryToken),
          creditedEndSu: Number(candidate.creditedEndSu)
        })
        if (result === 'advanced') {
          this.onCreditAvailable?.(identity.id)
        }
        this.pruneClosed(token, identity)
      } catch {
        /* Invalid and stale cumulative ACKs never mutate credit. */
      }
    }
  }

  cancel(
    params: Record<string, unknown>,
    grant: Readonly<PtyConsumerSessionGrant> | null
  ): Readonly<{ canceled: true; sentEndSu: number; creditedEndSu: number }> {
    const token = typeof params.deliveryToken === 'string' ? params.deliveryToken : ''
    const identity = this.identityByToken.get(token)
    const recent = this.recentCancellations.owned(token, params, grant)
    if (!identity && recent) {
      return ptySourceCancellationResult(recent)
    }
    if (
      !grant?.capabilities?.outputFlowControl ||
      !identity ||
      identity.clientGeneration !== grant.clientGeneration ||
      params.id !== identity.id ||
      Number(params.clientGeneration) !== identity.clientGeneration ||
      Number(params.ownerGeneration) !== identity.ownerGeneration
    ) {
      throw new Error('Unknown or stale PTY source delivery cancellation')
    }
    const proof = this.sourceCredit.cancel(identity, 'client-request')
    this.identityByToken.delete(token)
    this.recentCancellations.remember(proof)
    this.clearGraceWhenSettled(identity.ownerGeneration)
    // Why: the publication must retire its record the moment the delivery closes, or the next
    // exit seals a dead ledger entry.
    notifyPtySourceCreditAvailable(this.onCreditAvailable, identity.id)
    return ptySourceCancellationResult(proof)
  }

  retainOrCloseOnDetach(grant: Readonly<PtyConsumerSessionGrant>): void {
    if (grant.role === 'session-owner' && grant.capabilities?.outputFlowControl) {
      if (this.hasOwnerDeliveries(grant.ownerGeneration!)) {
        this.scheduleGraceExpiry(grant.ownerGeneration!)
      }
      return
    }
    this.closeClientDeliveries(grant.clientGeneration)
  }

  retentionSnapshot() {
    return Object.freeze({
      deliveryTokens: this.identityByToken.size,
      graceTimers: this.graceTimers.size,
      ...this.sourceCredit.retentionSnapshot()
    })
  }

  ownsDelivery(
    token: string,
    grant: Readonly<PtyConsumerSessionGrant>,
    id: string
  ): PtySourceDeliveryIdentity | null {
    return ownedPtySourceDelivery(this.identityByToken.get(token), grant, id)
  }

  cancelIdentity(identity: PtySourceDeliveryIdentity, reason: string): void {
    const token = identity.deliveryToken
    if (this.identityByToken.get(token) !== identity) {
      return
    }
    this.cancelExact(token, identity, reason)
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.graceTimers.forEach((timer) => clearTimeout(timer))
    this.graceTimers.clear()
    this.sourceCredit.closeGeneration(this.relayProviderGeneration)
    this.identityByToken.clear()
    this.recentCancellations.clear()
  }

  private closeClientDeliveries(clientGeneration: number): void {
    for (const [token, identity] of this.identityByToken) {
      if (identity.clientGeneration !== clientGeneration) {
        continue
      }
      this.cancelExact(token, identity, 'client-detached')
      notifyPtySourceCreditAvailable(this.onCreditAvailable, identity.id)
    }
  }

  private scheduleGraceExpiry(ownerGeneration: number): void {
    this.clearGraceTimer(ownerGeneration)
    const timer = setTimeout(() => {
      this.graceTimers.delete(ownerGeneration)
      for (const [token, identity] of this.identityByToken) {
        if (identity.ownerGeneration !== ownerGeneration) {
          continue
        }
        this.cancelExact(token, identity, 'reconnect-grace-expired')
        notifyPtySourceCreditAvailable(this.onCreditAvailable, identity.id)
      }
    }, PTY_CONSUMER_OWNER_GRACE_MS)
    timer.unref?.()
    this.graceTimers.set(ownerGeneration, timer)
  }

  private cancelExact(token: string, identity: PtySourceDeliveryIdentity, reason: string): void {
    // Why: this runs from the bare grace setTimeout, where an evicted tombstone probing unknown
    // would throw straight into uncaughtException.
    const snapshot = this.sourceCredit.snapshotIfKnown(identity)
    if (snapshot && snapshot.state !== 'closed') {
      const proof = this.sourceCredit.cancel(identity, reason)
      this.recentCancellations.remember(proof)
      this.publishCancellation?.(proof)
    }
    if (this.identityByToken.get(token) === identity) {
      this.identityByToken.delete(token)
    }
    this.clearGraceWhenSettled(identity.ownerGeneration)
  }

  private pruneClosed(token: string, identity: PtySourceDeliveryIdentity): void {
    if (
      this.sourceCredit.snapshot(identity).state === 'closed' &&
      this.identityByToken.get(token) === identity
    ) {
      this.identityByToken.delete(token)
      this.clearGraceWhenSettled(identity.ownerGeneration)
    }
  }

  private hasOwnerDeliveries = (ownerGeneration: number): boolean =>
    Array.from(this.identityByToken.values()).some(
      (identity) => identity.ownerGeneration === ownerGeneration
    )

  private clearGraceWhenSettled(ownerGeneration: number): void {
    if (!this.hasOwnerDeliveries(ownerGeneration)) {
      this.clearGraceTimer(ownerGeneration)
    }
  }

  private clearGraceTimer(ownerGeneration: number): void {
    clearTimeout(this.graceTimers.get(ownerGeneration))
    this.graceTimers.delete(ownerGeneration)
  }
}
