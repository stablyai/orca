import {
  ptySourceDeliveryKey,
  ptySourceSpanIsSplittable,
  samePtySourceDelivery,
  type PtySourceCreditAck,
  type PtySourceDeliveryCancellation,
  type PtySourceDeliveryIdentity,
  type PtySourceDeliverySnapshot,
  type PtySourceSpan
} from '../shared/pty-source-credit-contract'
import {
  assertNonNegativeSafeInteger,
  assertPositiveSafeInteger,
  assertPtySourceIdentity
} from '../shared/pty-source-credit-validation'
import {
  resolvePtySourceCreditLimits,
  type PtySourceCreditLedgerOptions,
  type PtySourceCreditLimits
} from './pty-source-credit-limits'
import {
  CLOSED_DELIVERY_TOMBSTONE_LIMIT,
  closeDeliveryGeneration,
  createAppendedSourceSpan,
  createDeliveryCancellation,
  createDeliveryRecord,
  createReplacementDeliveryRecord,
  findPtySourceSpanForSend,
  matchingDeliverySnapshot,
  MAX_SOURCE_SPAN_DATA_BYTES,
  ptyOwnerKey,
  sliceForSend,
  snapshotDeliveryRecord,
  type DeliveryRecord,
  type PtySourceAppendInput,
  type PtySourceSendReservation
} from './pty-source-credit-record'
import {
  acknowledgeDeliveryRecord,
  commitPtySourceSend,
  reservedPtySourceSendLength,
  rollbackPtySourceSend,
  type PtySourceAckResult
} from './pty-source-credit-settlement'
import { chargedPtyRetainedStringBytes } from '../shared/pty-retained-string-memory'
import { PtySourceCreditRetention } from './pty-source-credit-retention'

export type { PtySourceSendReservation } from './pty-source-credit-record'
export type { PtySourceCreditLedgerOptions } from './pty-source-credit-limits'

export class RelayPtySourceCreditLedger {
  private readonly deliveries = new Map<string, DeliveryRecord>()
  private readonly upstreamOwnerByPty = new Map<string, string>()
  private readonly closedSnapshots = new Map<string, PtySourceDeliverySnapshot>()
  private readonly limits: PtySourceCreditLimits
  private readonly retention = new PtySourceCreditRetention()
  private nextReservationId = 1

  constructor(options: PtySourceCreditLedgerOptions = {}) {
    this.limits = resolvePtySourceCreditLimits(options)
  }

  open(
    identity: PtySourceDeliveryIdentity,
    windowSu: number,
    checkpointSourceEndSu = 0
  ): PtySourceDeliverySnapshot {
    assertPtySourceIdentity(identity)
    assertPositiveSafeInteger(windowSu, 'windowSu')
    assertNonNegativeSafeInteger(checkpointSourceEndSu, 'checkpointSourceEndSu')
    const key = ptySourceDeliveryKey(identity)
    if (this.deliveries.has(key) || this.closedSnapshots.has(key)) {
      throw new Error('PTY source delivery token was already used')
    }
    const ownerKey = ptyOwnerKey(identity)
    if (this.upstreamOwnerByPty.has(ownerKey)) {
      throw new Error('PTY source delivery already has an upstream owner')
    }
    const record = createDeliveryRecord(identity, windowSu, checkpointSourceEndSu)
    this.deliveries.set(key, record)
    this.upstreamOwnerByPty.set(ownerKey, key)
    return snapshotDeliveryRecord(record)
  }

  append(identity: PtySourceDeliveryIdentity, input: PtySourceAppendInput): PtySourceSpan {
    const record = this.requireActive(identity)
    const sourceEndSu = record.receivedEndSu + input.transform.rawLengthSu
    const encodedDataBytes = Buffer.byteLength(input.data, 'utf8')
    const retainedDataBytes = chargedPtyRetainedStringBytes(input.data)
    if (encodedDataBytes > MAX_SOURCE_SPAN_DATA_BYTES) {
      throw new Error('PTY source span encoded-data budget exceeded')
    }
    if (sourceEndSu - record.creditedEndSu > this.limits.maxRetainedSourceSu) {
      throw new Error('PTY source retained-range budget exceeded')
    }
    if (
      this.retainedSourceSu() + input.transform.rawLengthSu >
      this.limits.maxAggregateRetainedSourceSu
    ) {
      throw new Error('Aggregate PTY source retained-range budget exceeded')
    }
    if (record.retainedDataBytes + retainedDataBytes > this.limits.maxRetainedDataBytes) {
      throw new Error('PTY source retained encoded-data budget exceeded')
    }
    if (this.retainedDataBytes() + retainedDataBytes > this.limits.maxAggregateRetainedDataBytes) {
      throw new Error('Aggregate PTY source retained encoded-data budget exceeded')
    }
    if (record.spans.length + 1 > this.limits.maxRetainedSpans) {
      throw new Error('PTY source retained-span budget exceeded')
    }
    if (this.retainedSpans() + 1 > this.limits.maxAggregateRetainedSpans) {
      throw new Error('Aggregate PTY source retained-span budget exceeded')
    }
    const span = createAppendedSourceSpan(record, input)
    record.spans.push(span)
    record.retainedDataBytes += retainedDataBytes
    record.receivedEndSu = sourceEndSu
    this.retention.addSpan(input.transform.rawLengthSu, retainedDataBytes)
    return span
  }

  reserveNextSend(
    identity: PtySourceDeliveryIdentity,
    maxSourceSu = 16 * 1024
  ): PtySourceSendReservation | null {
    assertPositiveSafeInteger(maxSourceSu, 'maxSourceSu')
    const record = this.requireDelivery(identity)
    if (record.state !== 'active' && record.state !== 'sealed-unsettled') {
      return null
    }
    if (record.pendingSend) {
      throw new Error('PTY source delivery already has a pending send reservation')
    }
    const remainingWindowSu = record.windowSu - (record.sentEndSu - record.creditedEndSu)
    if (remainingWindowSu <= 0 || record.sentEndSu >= record.receivedEndSu) {
      return null
    }
    const containing = findPtySourceSpanForSend(record)
    if (!containing || containing.sourceStartSu > record.sentEndSu) {
      throw new Error('PTY source delivery cursor is not covered by the retained ledger')
    }
    const reservedLengthSu = reservedPtySourceSendLength(record, remainingWindowSu, maxSourceSu)
    if (reservedLengthSu === null) {
      return null
    }
    const available = reservedLengthSu ?? Math.min(remainingWindowSu, maxSourceSu)
    if (
      (!ptySourceSpanIsSplittable(containing) || containing.transform.transformed) &&
      containing.sourceEndSu - record.sentEndSu > available
    ) {
      return null
    }
    const span = sliceForSend(containing, record.sentEndSu, available)
    const reservation = Object.freeze({
      reservationId: `pty-source-send:${this.nextReservationId++}`,
      identity: record.identity,
      span
    })
    record.pendingSend = reservation
    record.attemptedEndSu = span.sourceEndSu
    return reservation
  }

  commitSend(reservation: PtySourceSendReservation): void {
    const record = this.requireDelivery(reservation.identity)
    const settled = this.retention.trackMutation(record, () =>
      commitPtySourceSend(record, reservation)
    )
    if (settled) {
      this.maybeClose(record)
    }
  }

  rollbackSend(reservation: PtySourceSendReservation): void {
    const record = this.requireDelivery(reservation.identity)
    rollbackPtySourceSend(record, reservation)
  }

  acknowledge(identity: PtySourceDeliveryIdentity, ack: PtySourceCreditAck): PtySourceAckResult {
    const record = this.requireDelivery(identity)
    const result = this.retention.trackMutation(record, () =>
      acknowledgeDeliveryRecord(record, ack)
    )
    if (result === 'advanced') {
      this.maybeClose(record)
    }
    return result
  }

  seal(identity: PtySourceDeliveryIdentity): void {
    const record = this.requireActive(identity)
    record.state = 'sealed-unsettled'
  }

  settleExitPublication(
    identity: PtySourceDeliveryIdentity,
    result: { ok: true } | { ok: false; error: Error }
  ): void {
    const record = this.requireDelivery(identity)
    if (record.state !== 'sealed-unsettled') {
      throw new Error('PTY source delivery is not sealed')
    }
    if (!result.ok) {
      return
    }
    if (record.pendingSend || record.sentEndSu !== record.receivedEndSu) {
      throw new Error('PTY source exit cannot publish ahead of preceding source data')
    }
    record.exitPublished = true
    this.maybeClose(record)
  }

  cancel(
    identity: PtySourceDeliveryIdentity,
    reason: string,
    replacementDeliveryToken?: string
  ): PtySourceDeliveryCancellation {
    const record = this.requireDelivery(identity)
    record.state = 'closing'
    const proof = createDeliveryCancellation(record, reason, replacementDeliveryToken)
    this.closeRecord(record)
    return proof
  }

  closeGeneration(providerGeneration: number): number {
    assertPositiveSafeInteger(providerGeneration, 'providerGeneration')
    return closeDeliveryGeneration(this.deliveries.values(), providerGeneration, (record) =>
      this.closeRecord(record)
    )
  }

  rotate(
    oldIdentity: PtySourceDeliveryIdentity,
    newIdentity: PtySourceDeliveryIdentity,
    acceptedSourceEndSu: number,
    windowSu: number
  ): Readonly<{ cancellation: PtySourceDeliveryCancellation; recovery: readonly PtySourceSpan[] }> {
    const old = this.requireDelivery(oldIdentity)
    const replacementKey = ptySourceDeliveryKey(newIdentity)
    if (this.deliveries.has(replacementKey) || this.closedSnapshots.has(replacementKey)) {
      throw new Error('PTY source replacement token was already used')
    }
    const replacement = createReplacementDeliveryRecord(
      old,
      newIdentity,
      acceptedSourceEndSu,
      windowSu
    )
    this.upstreamOwnerByPty.delete(ptyOwnerKey(old.identity))
    this.deliveries.set(replacementKey, replacement)
    // Retention mirrors the delivery map, so count the replacement as it enters, not after cancel.
    this.retention.addRecord(replacement)
    this.upstreamOwnerByPty.set(ptyOwnerKey(replacement.identity), replacementKey)
    const cancellation = this.cancel(oldIdentity, 'superseded', newIdentity.deliveryToken)
    return Object.freeze({ cancellation, recovery: Object.freeze(replacement.spans.slice()) })
  }

  // Why: callers that can legitimately race a close probe instead of throwing; an evicted
  // tombstone reads as null and must be treated as closed.
  snapshotIfKnown(identity: PtySourceDeliveryIdentity): PtySourceDeliverySnapshot | null {
    return matchingDeliverySnapshot(this.deliveries, this.closedSnapshots, identity)
  }

  snapshot(identity: PtySourceDeliveryIdentity): PtySourceDeliverySnapshot {
    const snapshot = this.snapshotIfKnown(identity)
    if (!snapshot) {
      throw new Error('Unknown or stale PTY source delivery')
    }
    return snapshot
  }

  retainedSourceSu = (): number => this.retention.retainedSourceSu()

  retainedDataBytes = (): number => this.retention.retainedDataBytes()

  retainedSpans = (): number => this.retention.retainedSpans()

  retentionSnapshot = () => this.retention.snapshot()

  private requireActive(identity: PtySourceDeliveryIdentity): DeliveryRecord {
    const record = this.requireDelivery(identity)
    if (record.state !== 'active') {
      throw new Error('PTY source delivery does not admit new source')
    }
    return record
  }

  private requireDelivery(identity: PtySourceDeliveryIdentity): DeliveryRecord {
    const record = this.deliveries.get(ptySourceDeliveryKey(identity))
    if (!record || !samePtySourceDelivery(record.identity, identity)) {
      throw new Error('Unknown or stale PTY source delivery')
    }
    return record
  }

  private maybeClose(record: DeliveryRecord): void {
    if (
      record.state === 'sealed-unsettled' &&
      record.exitPublished &&
      record.creditedEndSu === record.receivedEndSu
    ) {
      this.closeRecord(record)
    }
  }

  private closeRecord(record: DeliveryRecord): void {
    if (record.state === 'closed') {
      return
    }
    this.retention.removeRecord(record)
    record.state = 'closed'
    record.pendingSend = null
    record.spans = []
    record.retainedDataBytes = 0
    record.sendSpanIndex = 0
    const key = ptySourceDeliveryKey(record.identity)
    const ownerKey = ptyOwnerKey(record.identity)
    if (this.upstreamOwnerByPty.get(ownerKey) === key) {
      this.upstreamOwnerByPty.delete(ownerKey)
    }
    this.deliveries.delete(key)
    this.closedSnapshots.set(key, snapshotDeliveryRecord(record))
    while (this.closedSnapshots.size > CLOSED_DELIVERY_TOMBSTONE_LIMIT) {
      this.closedSnapshots.delete(this.closedSnapshots.keys().next().value!)
    }
  }
}
