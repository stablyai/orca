import type { RelayPtyOwnershipTransferSource } from './relay-pty-ownership-transfer-adapter-contract'
import type { RelayPtySourceDeliveryRecord } from './relay-pty-source-send-scheduler'
import type { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'
import {
  samePtySourceDelivery,
  type PtySourceDeliveryIdentity,
  type PtySourceDeliverySnapshot
} from '../shared/pty-source-credit-contract'

/** Exact live owner lookup used before any source-side transfer mutation. */
export class RelayPtyOwnershipTransferSourceResolver {
  constructor(
    private readonly deliveries: ReadonlyMap<string, RelayPtySourceDeliveryRecord>,
    private readonly session: SshPtyConsumerSessionAdapter
  ) {}

  resolve(id: string): RelayPtyOwnershipTransferSource | null {
    const record = this.deliveries.get(id)
    if (!record) {
      return null
    }
    const owner = this.session.activeSessionOwner(record.clientId)
    if (!owner || owner.ownerGeneration !== record.identity.ownerGeneration) {
      return null
    }
    return Object.freeze({
      terminalId: id,
      incarnationId: record.identity.ptyIncarnation,
      ownerLease: owner.ownerLease,
      sourceOwnerGeneration: owner.ownerGeneration
    })
  }

  authorizes(
    id: string,
    ownerLease: string,
    sourceOwnerGeneration: number,
    clientId: number
  ): boolean {
    const record = this.deliveries.get(id)
    if (!record || record.clientId !== clientId) {
      return false
    }
    const source = this.resolve(id)
    return (
      source?.ownerLease === ownerLease && source.sourceOwnerGeneration === sourceOwnerGeneration
    )
  }

  /** Delivery evidence only; the caller must separately fence ingress and bind a transfer cursor. */
  inspectDrainedDelivery(
    source: RelayPtyOwnershipTransferSource,
    clientId: number
  ): PtySourceDeliverySnapshot | null {
    return this.inspectAuthorizedDelivery(source, () =>
      this.authorizes(source.terminalId, source.ownerLease, source.sourceOwnerGeneration, clientId)
    )
  }

  /** Evidence only; caller must bind the host-issued capture and retain transfer ingress fences. */
  inspectSuccessorDrainedDelivery(
    source: RelayPtyOwnershipTransferSource,
    clientId: number,
    expected: PtySourceDeliverySnapshot
  ): PtySourceDeliverySnapshot | null {
    const snapshot = this.inspectSuccessorRetainedDelivery(source, clientId, expected)
    return snapshot &&
      expected.state === 'active' &&
      !expected.generationClosed &&
      !expected.exitPublished &&
      snapshot.receivedEndSu === snapshot.sentEndSu &&
      snapshot.sentEndSu === snapshot.creditedEndSu &&
      snapshot.sentEndSu === expected.sentEndSu &&
      snapshot.creditedEndSu === expected.creditedEndSu
      ? snapshot
      : null
  }

  /** Actual counters only; journal coverage and destination custody are separate evidence. */
  inspectSuccessorRetainedDelivery(
    source: RelayPtyOwnershipTransferSource,
    clientId: number,
    expected: PtySourceDeliveryIdentity & Readonly<{ windowSu: number; receivedEndSu: number }>
  ): PtySourceDeliverySnapshot | null {
    const owner = this.session.activeSessionOwner(clientId)
    if (
      !owner ||
      !this.authorizesResumedTransfer(source.ownerLease, source.sourceOwnerGeneration, clientId) ||
      this.deliveries.get(source.terminalId)?.sendWaiters.size ||
      this.deliveries.get(source.terminalId)?.legacyExitAccepted
    ) {
      return null
    }
    const snapshot = this.inspectAuthorizedDelivery(
      source,
      () =>
        this.authorizesResumedTransferAtGeneration(
          source.ownerLease,
          owner.ownerGeneration,
          clientId
        ) &&
        !this.deliveries.get(source.terminalId)?.sendWaiters.size &&
        !this.deliveries.get(source.terminalId)?.legacyExitAccepted,
      false
    )
    if (
      !snapshot ||
      !samePtySourceDelivery(snapshot, expected) ||
      snapshot.windowSu !== expected.windowSu ||
      snapshot.receivedEndSu !== expected.receivedEndSu
    ) {
      return null
    }
    return snapshot
  }

  private inspectAuthorizedDelivery(
    source: RelayPtyOwnershipTransferSource,
    authorized: () => boolean,
    requireDrained = true
  ): PtySourceDeliverySnapshot | null {
    const record = this.deliveries.get(source.terminalId)
    if (
      !record ||
      record.identity.ptyIncarnation !== source.incarnationId ||
      record.identity.ownerGeneration !== source.sourceOwnerGeneration ||
      !authorized() ||
      record.activating ||
      record.rotationPending ||
      record.restoreRequired ||
      record.sealed ||
      record.sending ||
      record.turnScheduled ||
      record.sourceExitState !== 'idle' ||
      record.recoveryEndSu !== null ||
      record.recoveryCompletionPending
    ) {
      return null
    }
    try {
      const snapshot = this.session.sourceDeliverySnapshot(record.identity)
      if (
        !samePtySourceDelivery(snapshot, record.identity) ||
        snapshot.state !== 'active' ||
        snapshot.generationClosed ||
        snapshot.exitPublished ||
        (requireDrained &&
          (snapshot.receivedEndSu !== snapshot.sentEndSu ||
            snapshot.sentEndSu !== snapshot.creditedEndSu)) ||
        !Number.isSafeInteger(snapshot.sentEndSu) ||
        !Number.isSafeInteger(snapshot.creditedEndSu) ||
        snapshot.creditedEndSu < 0 ||
        snapshot.creditedEndSu > snapshot.sentEndSu ||
        snapshot.sentEndSu > snapshot.receivedEndSu ||
        !Number.isSafeInteger(snapshot.receivedEndSu) ||
        snapshot.receivedEndSu < 0 ||
        this.deliveries.get(source.terminalId) !== record ||
        !authorized()
      ) {
        return null
      }
      return Object.freeze({ ...snapshot })
    } catch {
      return null
    }
  }

  authorizesResumedTransfer(
    ownerLease: string,
    sourceOwnerGeneration: number,
    clientId: number
  ): boolean {
    const owner = this.session.activeSessionOwner(clientId)
    return Boolean(
      Number.isSafeInteger(sourceOwnerGeneration) &&
      sourceOwnerGeneration > 0 &&
      owner &&
      owner.ownerLease === ownerLease &&
      owner.ownerGeneration > sourceOwnerGeneration
    )
  }

  /** Exact generation check used after a durable route rekey; later owners cannot reuse it. */
  authorizesResumedTransferAtGeneration(
    ownerLease: string,
    reconnectGeneration: number,
    clientId: number
  ): boolean {
    const owner = this.session.activeSessionOwner(clientId)
    return Boolean(
      Number.isSafeInteger(reconnectGeneration) &&
      reconnectGeneration > 0 &&
      owner &&
      owner.ownerLease === ownerLease &&
      owner.ownerGeneration === reconnectGeneration
    )
  }
}
