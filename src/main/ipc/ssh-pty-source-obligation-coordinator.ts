import {
  ptySourceDeliveryKey,
  samePtySourceDelivery,
  type PtySourceDeliveryIdentity,
  type PtySourceSpan
} from '../../shared/pty-source-credit-contract'
import {
  SshPtySourceAckCoalescer,
  type SshPtySourceAckCoalescerOptions
} from './ssh-pty-source-ack-coalescer'
import {
  SshPtySourceObligationLedger,
  type SshPtySourceAdmissionReservation,
  type SshPtySourceConsumerId,
  type SshPtySourceObligationState,
  type SshPtySourceTokenSnapshot
} from './ssh-pty-source-obligation-ledger'

export type SshPtySourceObligationTransition = Readonly<{
  identity: PtySourceDeliveryIdentity
  spanId: string
  consumer: SshPtySourceConsumerId
  reason: string
}>

type TerminalWaiter = {
  resolve: () => void
  reject: (error: Error) => void
}

type TerminalWaiterGroup = {
  identity: PtySourceDeliveryIdentity
  waiters: Set<TerminalWaiter>
}

export class SshPtySourceObligationCoordinator {
  private readonly ledger: SshPtySourceObligationLedger
  private readonly acknowledgements: SshPtySourceAckCoalescer
  private readonly terminalWaiters = new Map<string, TerminalWaiterGroup>()
  private disposed = false

  constructor(options: SshPtySourceAckCoalescerOptions) {
    this.ledger = new SshPtySourceObligationLedger(options.onTokenClosed)
    this.acknowledgements = new SshPtySourceAckCoalescer(options)
  }

  open(identity: PtySourceDeliveryIdentity, checkpointSourceEndSu = 0): void {
    if (this.disposed) {
      throw new Error('SSH PTY source obligation coordinator is disposed')
    }
    this.ledger.open(identity, checkpointSourceEndSu)
  }

  reserve(
    identity: PtySourceDeliveryIdentity,
    span: PtySourceSpan,
    requiredConsumers: readonly SshPtySourceConsumerId[]
  ): SshPtySourceAdmissionReservation {
    return this.ledger.reserve(identity, span, requiredConsumers)
  }

  commit(reservation: SshPtySourceAdmissionReservation): void {
    this.ledger.commit(reservation)
  }

  rollback(reservation: SshPtySourceAdmissionReservation): boolean {
    return this.ledger.rollback(reservation)
  }

  rollbackCommitted(reservation: SshPtySourceAdmissionReservation): boolean {
    const rolledBack = this.ledger.rollbackCommitted(reservation)
    if (rolledBack) {
      this.maybeResolveTerminal(reservation.span)
    }
    return rolledBack
  }

  settle(transition: SshPtySourceObligationTransition): boolean {
    this.requireSpanIdentity(transition)
    const changed = this.ledger.settle(transition.spanId, transition.consumer, transition.reason)
    this.queueEligibleAck(transition.identity)
    return changed
  }

  beginTransfer(transition: SshPtySourceObligationTransition, to: SshPtySourceConsumerId): boolean {
    this.requireSpanIdentity(transition)
    return this.ledger.beginTransfer(transition.spanId, transition.consumer, to, transition.reason)
  }

  commitTransfer(transition: Omit<SshPtySourceObligationTransition, 'reason'>): boolean {
    this.requireSpanIdentity(transition)
    const changed = this.ledger.commitTransfer(transition.spanId, transition.consumer)
    this.queueEligibleAck(transition.identity)
    return changed
  }

  cancelTransfer(transition: SshPtySourceObligationTransition): boolean {
    this.requireSpanIdentity(transition)
    const changed = this.ledger.cancelTransfer(
      transition.spanId,
      transition.consumer,
      transition.reason
    )
    this.queueEligibleAck(transition.identity)
    return changed
  }

  rollbackTransfer(transition: SshPtySourceObligationTransition): boolean {
    this.requireSpanIdentity(transition)
    return this.ledger.rollbackTransfer(transition.spanId, transition.consumer)
  }

  seal(identity: PtySourceDeliveryIdentity): void {
    if (this.ledger.snapshot(identity).state === 'sealed-unsettled') {
      return
    }
    this.ledger.seal(identity)
  }

  markExitPublished(identity: PtySourceDeliveryIdentity): void {
    this.queueEligibleAck(identity)
    this.ledger.markExitPublished(identity)
  }

  whenTerminal(identity: PtySourceDeliveryIdentity): Promise<void> {
    if (this.isTerminal(identity)) {
      return Promise.resolve()
    }
    const key = ptySourceDeliveryKey(identity)
    let group = this.terminalWaiters.get(key)
    if (!group) {
      group = { identity: Object.freeze({ ...identity }), waiters: new Set() }
      this.terminalWaiters.set(key, group)
    }
    return new Promise((resolve, reject) => {
      group!.waiters.add({ resolve, reject })
    })
  }

  beginExitTimeout(identity: PtySourceDeliveryIdentity) {
    return this.ledger.beginExitTimeout(identity)
  }

  applyCancellationProof(
    identity: PtySourceDeliveryIdentity,
    proof: Readonly<{ sentEndSu: number; creditedEndSu: number }>
  ): void {
    const snapshot = this.ledger.snapshot(identity)
    if (
      snapshot.state === 'closed' &&
      snapshot.receivedEndSu === proof.sentEndSu &&
      snapshot.ackPublishedEndSu === proof.creditedEndSu
    ) {
      return
    }
    this.ledger.applyCancellationProof(identity, proof)
    this.rejectWaiters(
      (group) => samePtySourceDelivery(group.identity, identity),
      new Error('ssh_source_delivery_canceled')
    )
  }

  applyRecoveryCancellationProof(
    identity: PtySourceDeliveryIdentity,
    proof: Readonly<{ sentEndSu: number; creditedEndSu: number }>
  ): void {
    this.ledger.applyRecoveryCancellationProof(identity, proof)
    this.rejectWaiters(
      (group) => samePtySourceDelivery(group.identity, identity),
      new Error('ssh_source_delivery_canceled')
    )
  }

  closeGeneration(providerGeneration: number, reason: string): number {
    this.rejectWaiters(
      (group) => group.identity.providerGeneration === providerGeneration,
      new Error(reason)
    )
    const closed = this.ledger.closeGeneration(providerGeneration, reason)
    this.acknowledgements.cancelGeneration(providerGeneration, reason)
    return closed
  }

  snapshot(identity: PtySourceDeliveryIdentity): SshPtySourceTokenSnapshot {
    return this.ledger.snapshot(identity)
  }

  modelAcceptedEnd(identity: PtySourceDeliveryIdentity): number {
    return this.ledger.modelAcceptedEnd(identity)
  }

  obligation(spanId: string, consumer: SshPtySourceConsumerId): SshPtySourceObligationState {
    return this.ledger.obligation(spanId, consumer)
  }

  spanIdentity(spanId: string): PtySourceSpan {
    return this.ledger.spanIdentity(spanId)
  }

  hasRetainedSpan(spanId: string): boolean {
    return this.ledger.hasRetainedSpan(spanId)
  }

  flushAcknowledgements(): void {
    this.acknowledgements.flush()
  }

  dispose(reason?: string): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.rejectWaiters(() => true, new Error(reason ?? 'SSH PTY source obligations disposed'))
    this.ledger.closeAll(reason ?? 'SSH PTY source obligation coordinator disposed')
    this.acknowledgements.dispose(reason)
  }

  private queueEligibleAck(identity: PtySourceDeliveryIdentity): void {
    const publication = this.ledger.queueAck(identity)
    if (publication) {
      this.acknowledgements.enqueue(publication)
    }
    this.maybeResolveTerminal(identity)
  }

  private isTerminal(identity: PtySourceDeliveryIdentity): boolean {
    const snapshot = this.ledger.snapshot(identity)
    return (
      snapshot.obligationsTerminalEndSu === snapshot.receivedEndSu &&
      snapshot.ackQueuedEndSu === snapshot.receivedEndSu
    )
  }

  private maybeResolveTerminal(identity: PtySourceDeliveryIdentity): void {
    if (!this.isTerminal(identity)) {
      return
    }
    const group = this.terminalWaiters.get(ptySourceDeliveryKey(identity))
    if (!group) {
      return
    }
    this.terminalWaiters.delete(ptySourceDeliveryKey(identity))
    for (const waiter of group.waiters) {
      waiter.resolve()
    }
  }

  private rejectWaiters(predicate: (group: TerminalWaiterGroup) => boolean, error: Error): void {
    for (const [key, group] of this.terminalWaiters) {
      if (!predicate(group)) {
        continue
      }
      this.terminalWaiters.delete(key)
      for (const waiter of group.waiters) {
        waiter.reject(error)
      }
    }
  }

  private requireSpanIdentity(
    transition: Pick<SshPtySourceObligationTransition, 'identity' | 'spanId'>
  ): void {
    if (!samePtySourceDelivery(this.ledger.spanIdentity(transition.spanId), transition.identity)) {
      throw new Error('SSH PTY source obligation transition has a stale delivery identity')
    }
  }
}
