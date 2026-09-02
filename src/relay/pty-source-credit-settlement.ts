import type { PtySourceCreditAck } from '../shared/pty-source-credit-contract'
import { assertPtySourceAck } from '../shared/pty-source-credit-validation'
import { chargedPtyRetainedStringBytes } from '../shared/pty-retained-string-memory'
import type { DeliveryRecord, PtySourceSendReservation } from './pty-source-credit-record'

export type PtySourceAckResult = 'advanced' | 'reserved' | 'duplicate' | 'regression'

export function reservedPtySourceSendLength(
  record: DeliveryRecord,
  remainingWindowSu: number,
  maxSourceSu: number
): number | null | undefined {
  if (record.reservedAckEndSu === null) {
    return undefined
  }
  const lengthSu = record.reservedAckEndSu - record.sentEndSu
  return lengthSu > 0 && lengthSu <= remainingWindowSu && lengthSu <= maxSourceSu ? lengthSu : null
}

function reclaimCreditedSpans(record: DeliveryRecord): void {
  let removed = 0
  while (record.spans[0]?.sourceEndSu <= record.creditedEndSu) {
    record.retainedDataBytes -= chargedPtyRetainedStringBytes(record.spans.shift()!.data)
    removed += 1
  }
  if (removed > 0) {
    record.sendSpanIndex = Math.max(0, record.sendSpanIndex - removed)
  }
}

function advanceCredit(record: DeliveryRecord, creditedEndSu: number): void {
  record.creditedEndSu = creditedEndSu
  record.sentBoundaries.dropBelow(creditedEndSu)
  reclaimCreditedSpans(record)
}

export function acknowledgeDeliveryRecord(
  record: DeliveryRecord,
  ack: PtySourceCreditAck
): PtySourceAckResult {
  assertPtySourceAck(ack)
  if (record.state === 'closed' || record.state === 'closing') {
    throw new Error('PTY source ACK targets a closed delivery')
  }
  if (
    ack.id !== record.identity.id ||
    ack.clientGeneration !== record.identity.clientGeneration ||
    ack.ownerGeneration !== record.identity.ownerGeneration ||
    ack.deliveryToken !== record.identity.deliveryToken
  ) {
    throw new Error('PTY source ACK does not own this delivery')
  }
  const reservedBoundarySu = record.pendingSend?.span.sourceEndSu ?? record.reservedAckEndSu
  const eligibleEndSu = reservedBoundarySu ?? record.sentEndSu
  if (ack.creditedEndSu > eligibleEndSu) {
    throw new Error('PTY source ACK exceeds sent source credit')
  }
  if (ack.creditedEndSu === record.creditedEndSu) {
    return 'duplicate'
  }
  if (ack.creditedEndSu < record.creditedEndSu) {
    return 'regression'
  }
  if (ack.creditedEndSu > record.sentEndSu) {
    if (ack.creditedEndSu !== reservedBoundarySu) {
      throw new Error('PTY source ACK does not match a reserved send boundary')
    }
    record.reservedAckEndSu = ack.creditedEndSu
    return 'reserved'
  }
  if (!record.sentBoundaries.has(ack.creditedEndSu)) {
    throw new Error('PTY source ACK does not match a committed send boundary')
  }
  advanceCredit(record, ack.creditedEndSu)
  return 'advanced'
}

export function settleReservedPtySourceAck(record: DeliveryRecord): boolean {
  const creditedEndSu = record.reservedAckEndSu
  record.reservedAckEndSu = null
  if (creditedEndSu === null) {
    return false
  }
  if (creditedEndSu !== record.sentEndSu || !record.sentBoundaries.has(creditedEndSu)) {
    throw new Error('PTY source reserved ACK does not match the settled send boundary')
  }
  advanceCredit(record, creditedEndSu)
  return true
}

export function commitPtySourceSend(
  record: DeliveryRecord,
  reservation: PtySourceSendReservation
): boolean {
  if (record.pendingSend !== reservation) {
    throw new Error('PTY source send reservation is stale')
  }
  // sentBoundaries lookups and cleanup both assume ascending order, so inserts must ascend.
  if (reservation.span.sourceEndSu <= record.sentEndSu) {
    throw new Error('PTY source send reservation regresses the sent boundary')
  }
  record.pendingSend = null
  record.sentEndSu = reservation.span.sourceEndSu
  record.sentBoundaries.add(record.sentEndSu)
  record.attemptedEndSu = null
  return settleReservedPtySourceAck(record)
}

export function rollbackPtySourceSend(
  record: DeliveryRecord,
  reservation: PtySourceSendReservation
): void {
  if (record.pendingSend !== reservation) {
    return
  }
  record.pendingSend = null
}
