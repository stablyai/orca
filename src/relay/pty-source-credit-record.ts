import type {
  PtySourceDeliveryIdentity,
  PtySourceDeliveryCancellation,
  PtySourceDeliverySnapshot,
  PtySourceSpan,
  PtySourceTransform
} from '../shared/pty-source-credit-contract'
import { ptySourceSpanIsSplittable } from '../shared/pty-source-credit-contract'
import {
  assertNonNegativeSafeInteger,
  assertPositiveSafeInteger,
  assertPtySourceIdentity,
  assertPtySourceSpan
} from '../shared/pty-source-credit-validation'
import { chargedPtyRetainedStringBytes } from '../shared/pty-retained-string-memory'

export const DEFAULT_RETAINED_SOURCE_SU = 512 * 1024
export const DEFAULT_AGGREGATE_RETAINED_SOURCE_SU = 48 * 1024 * 1024
export const DEFAULT_RETAINED_DATA_BYTES = 2 * 1024 * 1024
export const DEFAULT_AGGREGATE_RETAINED_DATA_BYTES = 64 * 1024 * 1024
export const DEFAULT_RETAINED_SPANS = 1_024
export const DEFAULT_AGGREGATE_RETAINED_SPANS = 64 * 1_024
export const MAX_SOURCE_SPAN_DATA_BYTES = 1024 * 1024
export const CLOSED_DELIVERY_TOMBSTONE_LIMIT = 256

export type PtySourceSendReservation = Readonly<{
  reservationId: string
  identity: PtySourceDeliveryIdentity
  span: PtySourceSpan
}>

export type DeliveryRecord = {
  identity: PtySourceDeliveryIdentity
  state: 'active' | 'sealed-unsettled' | 'closing' | 'closed'
  windowSu: number
  receivedEndSu: number
  sentEndSu: number
  creditedEndSu: number
  retainedDataBytes: number
  spans: PtySourceSpan[]
  sentBoundaries: Set<number>
  pendingSend: PtySourceSendReservation | null
  reservedAckEndSu: number | null
  attemptedEndSu: number | null
  exitPublished: boolean
  generationClosed: boolean
}

export function ptyOwnerKey(identity: PtySourceDeliveryIdentity): string {
  return `${identity.providerGeneration}\0${identity.id}\0${identity.ptyIncarnation}`
}

export function createDeliveryRecord(
  identity: PtySourceDeliveryIdentity,
  windowSu: number,
  checkpointSourceEndSu: number
): DeliveryRecord {
  return {
    identity: Object.freeze({ ...identity }),
    state: 'active',
    windowSu,
    receivedEndSu: checkpointSourceEndSu,
    sentEndSu: checkpointSourceEndSu,
    creditedEndSu: checkpointSourceEndSu,
    retainedDataBytes: 0,
    spans: [],
    sentBoundaries: new Set([checkpointSourceEndSu]),
    pendingSend: null,
    reservedAckEndSu: null,
    attemptedEndSu: null,
    exitPublished: false,
    generationClosed: false
  }
}

export type PtySourceAppendInput = Readonly<{
  spanId: string
  data: string
  displayStart: number
  displayEnd: number
  splittable: boolean
  transform: PtySourceTransform
}>

export function createAppendedSourceSpan(
  record: DeliveryRecord,
  input: PtySourceAppendInput
): PtySourceSpan {
  const span = Object.freeze({
    ...record.identity,
    ...input,
    transform: Object.freeze({ ...input.transform }),
    sourceStartSu: record.receivedEndSu,
    sourceEndSu: record.receivedEndSu + input.transform.rawLengthSu
  })
  assertPtySourceSpan(span)
  return span
}

export function sliceAtSourceStart(span: PtySourceSpan, sourceStartSu: number): PtySourceSpan {
  if (sourceStartSu === span.sourceStartSu) {
    return span
  }
  if (!ptySourceSpanIsSplittable(span) || span.transform.transformed) {
    throw new Error('Indivisible PTY source span cannot be split for recovery')
  }
  const offset = sourceStartSu - span.sourceStartSu
  return Object.freeze({
    ...span,
    spanId: `${span.spanId}:suffix:${sourceStartSu}`,
    sourceStartSu,
    displayStart: span.displayStart + offset,
    data: span.data.slice(offset),
    transform: Object.freeze({
      ...span.transform,
      rawLengthSu: span.sourceEndSu - sourceStartSu
    })
  })
}

export function sliceForSend(
  span: PtySourceSpan,
  sourceStartSu: number,
  maxSourceSu: number
): PtySourceSpan {
  const remaining = sliceAtSourceStart(span, sourceStartSu)
  const sourceLengthSu = remaining.sourceEndSu - remaining.sourceStartSu
  if (sourceLengthSu <= maxSourceSu) {
    return remaining
  }
  if (!ptySourceSpanIsSplittable(remaining) || remaining.transform.transformed) {
    throw new Error('Indivisible PTY source span does not fit the available source window')
  }
  let endOffset = maxSourceSu
  const trailing = remaining.data.charCodeAt(endOffset - 1)
  const following = remaining.data.charCodeAt(endOffset)
  if (
    endOffset > 0 &&
    trailing >= 0xd800 &&
    trailing <= 0xdbff &&
    following >= 0xdc00 &&
    following <= 0xdfff
  ) {
    endOffset--
  }
  if (endOffset <= 0) {
    throw new Error('Available source window would split a surrogate pair')
  }
  return Object.freeze({
    ...remaining,
    spanId: `${remaining.spanId}:slice:${remaining.sourceStartSu + endOffset}`,
    sourceEndSu: remaining.sourceStartSu + endOffset,
    displayEnd: remaining.displayStart + endOffset,
    data: remaining.data.slice(0, endOffset),
    transform: Object.freeze({ ...remaining.transform, rawLengthSu: endOffset })
  })
}

export function snapshotDeliveryRecord(record: DeliveryRecord): PtySourceDeliverySnapshot {
  return Object.freeze({
    ...record.identity,
    state: record.state,
    windowSu: record.windowSu,
    receivedEndSu: record.receivedEndSu,
    sentEndSu: record.sentEndSu,
    creditedEndSu: record.creditedEndSu,
    exitPublished: record.exitPublished,
    generationClosed: record.generationClosed
  })
}

export function retainedSourceTotal(records: Iterable<DeliveryRecord>): number {
  let total = 0
  for (const record of records) {
    total += record.receivedEndSu - record.creditedEndSu
  }
  return total
}

export function retainedDataBytesTotal(records: Iterable<DeliveryRecord>): number {
  let total = 0
  for (const record of records) {
    total += record.retainedDataBytes
  }
  return total
}

export function retainedSpanTotal(records: Iterable<DeliveryRecord>): number {
  let total = 0
  for (const record of records) {
    total += record.spans.length
  }
  return total
}

export function createReplacementDeliveryRecord(
  old: DeliveryRecord,
  newIdentity: PtySourceDeliveryIdentity,
  acceptedSourceEndSu: number,
  windowSu: number
): DeliveryRecord {
  assertPtySourceIdentity(newIdentity)
  assertPositiveSafeInteger(windowSu, 'windowSu')
  assertNonNegativeSafeInteger(acceptedSourceEndSu, 'acceptedSourceEndSu')
  const committedCheckpoint =
    acceptedSourceEndSu <= old.sentEndSu && old.sentBoundaries.has(acceptedSourceEndSu)
  const attemptedCheckpoint = acceptedSourceEndSu === old.attemptedEndSu
  if (
    acceptedSourceEndSu < old.creditedEndSu ||
    (!committedCheckpoint && !attemptedCheckpoint) ||
    old.pendingSend ||
    newIdentity.id !== old.identity.id ||
    newIdentity.ptyIncarnation !== old.identity.ptyIncarnation ||
    newIdentity.providerGeneration !== old.identity.providerGeneration
  ) {
    throw new Error('PTY source recovery checkpoint does not exactly cover the retained delivery')
  }
  if (acceptedSourceEndSu > old.sentEndSu) {
    old.sentEndSu = acceptedSourceEndSu
    old.sentBoundaries.add(acceptedSourceEndSu)
  }
  old.attemptedEndSu = null
  const replacement = createDeliveryRecord(newIdentity, windowSu, acceptedSourceEndSu)
  replacement.state = old.state === 'sealed-unsettled' ? 'sealed-unsettled' : 'active'
  replacement.receivedEndSu = old.receivedEndSu
  replacement.spans = old.spans
    .filter((span) => span.sourceEndSu > acceptedSourceEndSu)
    .map((span) => sliceAtSourceStart(span, Math.max(span.sourceStartSu, acceptedSourceEndSu)))
    .map((span) => Object.freeze({ ...span, ...replacement.identity }))
  replacement.retainedDataBytes = replacement.spans.reduce(
    (bytes, span) => bytes + chargedPtyRetainedStringBytes(span.data),
    0
  )
  return replacement
}

export function createDeliveryCancellation(
  record: DeliveryRecord,
  reason: string,
  replacementDeliveryToken?: string
): PtySourceDeliveryCancellation {
  return Object.freeze({
    ...record.identity,
    reason,
    sentEndSu: record.sentEndSu,
    creditedEndSu: record.creditedEndSu,
    remainingStartSu: record.creditedEndSu,
    remainingEndSu: record.sentEndSu,
    ...(replacementDeliveryToken ? { replacementDeliveryToken } : {})
  })
}

export function closeDeliveryGeneration(
  records: Iterable<DeliveryRecord>,
  providerGeneration: number,
  close: (record: DeliveryRecord) => void
): number {
  let closed = 0
  for (const record of Array.from(records)) {
    if (record.identity.providerGeneration !== providerGeneration || record.state === 'closed') {
      continue
    }
    record.generationClosed = true
    close(record)
    closed++
  }
  return closed
}
