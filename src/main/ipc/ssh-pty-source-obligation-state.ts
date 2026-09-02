import type {
  PtySourceDeliveryIdentity,
  PtySourceSpan
} from '../../shared/pty-source-credit-contract'
import {
  ptySourceDeliveryKey,
  samePtySourceDelivery
} from '../../shared/pty-source-credit-contract'
import type {
  SshPtySourceAdmissionReservation,
  SshPtySourceConsumerId,
  SshPtySourceObligationState,
  SshPtySourceTokenSnapshot
} from './ssh-pty-source-obligation-contract'

export const CLOSED_SOURCE_TOKEN_TOMBSTONE_LIMIT = 256

export type SpanRecord = {
  span: PtySourceSpan
  obligations: Map<SshPtySourceConsumerId, SshPtySourceObligationState>
  owner: TokenRecord
}

export type ReservationRecord = {
  reservation: SshPtySourceAdmissionReservation
  state: 'reserved' | 'committed' | 'rolled-back'
}

export type TokenRecord = {
  identity: PtySourceDeliveryIdentity
  state: 'active' | 'sealed-unsettled' | 'canceling' | 'closed'
  checkpointSourceEndSu: number
  receivedEndSu: number
  obligationsTerminalEndSu: number
  ackQueuedEndSu: number
  ackPublishedEndSu: number
  spans: SpanRecord[]
  exitPublished: boolean
  generationClosed: boolean
}

export function createSourceToken(
  identity: PtySourceDeliveryIdentity,
  checkpointSourceEndSu: number
): TokenRecord {
  return {
    identity: Object.freeze({ ...identity }),
    state: 'active',
    checkpointSourceEndSu,
    receivedEndSu: checkpointSourceEndSu,
    obligationsTerminalEndSu: checkpointSourceEndSu,
    ackQueuedEndSu: checkpointSourceEndSu,
    ackPublishedEndSu: checkpointSourceEndSu,
    spans: [],
    exitPublished: false,
    generationClosed: false
  }
}

export function createSourceSpanRecord(
  owner: TokenRecord,
  span: PtySourceSpan,
  consumers: readonly SshPtySourceConsumerId[]
): SpanRecord {
  return {
    owner,
    span,
    obligations: new Map(
      consumers.map((consumer) => [consumer, Object.freeze({ state: 'open' as const })])
    )
  }
}

export function sealSourceToken(token: TokenRecord): void {
  if (token.state !== 'active') {
    throw new Error('SSH PTY source token cannot be sealed from its current state')
  }
  token.state = 'sealed-unsettled'
}

export function markSourceExitPublished(token: TokenRecord): void {
  if (token.state !== 'sealed-unsettled') {
    throw new Error('SSH PTY source exit publication requires a sealed token')
  }
  if (
    token.obligationsTerminalEndSu !== token.receivedEndSu ||
    token.ackQueuedEndSu !== token.receivedEndSu
  ) {
    throw new Error('SSH PTY source exit cannot publish before terminal ACK queueing')
  }
  token.exitPublished = true
}

export function beginSourceExitTimeout(token: TokenRecord): Readonly<{
  id: string
  deliveryToken: string
  clientGeneration: number
  ownerGeneration: number
}> {
  if (token.state !== 'sealed-unsettled') {
    throw new Error('SSH PTY source exit timeout requires a sealed token')
  }
  token.state = 'canceling'
  return Object.freeze({
    id: token.identity.id,
    deliveryToken: token.identity.deliveryToken,
    clientGeneration: token.identity.clientGeneration,
    ownerGeneration: token.identity.ownerGeneration
  })
}

function obligationIsTerminal(obligation: SshPtySourceObligationState): boolean {
  return (
    obligation.state === 'settled' ||
    obligation.state === 'transferred' ||
    obligation.state === 'canceled'
  )
}

export function snapshotSourceToken(token: TokenRecord): SshPtySourceTokenSnapshot {
  return Object.freeze({
    ...token.identity,
    state: token.state,
    receivedEndSu: token.receivedEndSu,
    obligationsTerminalEndSu: token.obligationsTerminalEndSu,
    ackQueuedEndSu: token.ackQueuedEndSu,
    ackPublishedEndSu: token.ackPublishedEndSu,
    openSpans: token.spans.length,
    exitPublished: token.exitPublished,
    generationClosed: token.generationClosed
  })
}

export function advanceSourceTerminalEnd(token: TokenRecord): void {
  let endSu = token.obligationsTerminalEndSu
  for (const record of token.spans) {
    if (record.span.sourceEndSu <= endSu) {
      continue
    }
    if (
      record.span.sourceStartSu !== endSu ||
      !Array.from(record.obligations.values()).every(obligationIsTerminal)
    ) {
      break
    }
    endSu = record.span.sourceEndSu
  }
  token.obligationsTerminalEndSu = endSu
}

export function cancelOpenSourceObligations(token: TokenRecord, reason: string): void {
  for (const record of token.spans) {
    for (const [consumer, obligation] of record.obligations) {
      if (obligation.state === 'open' || obligation.state === 'transferring') {
        record.obligations.set(consumer, Object.freeze({ state: 'canceled', reason }))
      }
    }
  }
  advanceSourceTerminalEnd(token)
}

export function reclaimPublishedSourcePrefix(
  token: TokenRecord,
  spanOwners: Map<string, SpanRecord>
): void {
  while (token.spans[0]?.span.sourceEndSu <= token.ackPublishedEndSu) {
    const record = token.spans.shift()!
    spanOwners.delete(record.span.spanId)
  }
}

export function releaseSourceTokenSpans(
  token: TokenRecord,
  spanOwners: Map<string, SpanRecord>
): void {
  for (const record of token.spans) {
    spanOwners.delete(record.span.spanId)
  }
  token.spans = []
}

export function releaseSourceTokenReservations(
  token: TokenRecord,
  reservations: Map<string, ReservationRecord>
): void {
  for (const [reservationId, record] of reservations) {
    if (samePtySourceDelivery(record.reservation.span, token.identity)) {
      record.state = 'rolled-back'
      reservations.delete(reservationId)
    }
  }
}

export function rollbackCommittedSourceSpan(
  token: TokenRecord,
  reservation: SshPtySourceAdmissionReservation,
  spanOwners: Map<string, SpanRecord>
): boolean {
  const last = token.spans.at(-1)
  if (
    last?.span !== reservation.span ||
    token.receivedEndSu !== reservation.span.sourceEndSu ||
    token.obligationsTerminalEndSu > reservation.span.sourceStartSu ||
    token.ackQueuedEndSu > reservation.span.sourceStartSu ||
    Array.from(last.obligations.values()).some((obligation) => obligation.state !== 'open')
  ) {
    return false
  }
  token.spans.pop()
  token.receivedEndSu = reservation.span.sourceStartSu
  spanOwners.delete(reservation.span.spanId)
  return true
}

export function requireSourceSpan(
  spanOwners: ReadonlyMap<string, SpanRecord>,
  spanId: string
): { token: TokenRecord; span: SpanRecord } {
  const span = spanOwners.get(spanId)
  if (!span || span.span.spanId !== spanId) {
    throw new Error('Unknown or reclaimed SSH PTY source span')
  }
  return { token: span.owner, span }
}

export function requireSourceReservation(
  reservations: ReadonlyMap<string, ReservationRecord>,
  reservation: SshPtySourceAdmissionReservation
): ReservationRecord {
  const record = reservations.get(reservation.reservationId)
  if (!record || record.reservation !== reservation) {
    throw new Error('Unknown SSH PTY source admission reservation')
  }
  return record
}

export function closeSourceGeneration(
  tokens: Map<string, TokenRecord>,
  reservations: Map<string, ReservationRecord>,
  providerGeneration: number,
  reason: string,
  closeToken: (token: TokenRecord) => void
): number {
  let closed = 0
  for (const token of Array.from(tokens.values())) {
    if (token.identity.providerGeneration !== providerGeneration || token.state === 'closed') {
      continue
    }
    token.generationClosed = true
    cancelOpenSourceObligations(token, reason)
    closeToken(token)
    closed++
  }
  for (const [id, record] of reservations) {
    if (
      record.state === 'reserved' &&
      record.reservation.span.providerGeneration === providerGeneration
    ) {
      record.state = 'rolled-back'
      reservations.delete(id)
    }
  }
  return closed
}

export function closeAllSourceTokens(
  tokens: Map<string, TokenRecord>,
  reservations: Map<string, ReservationRecord>,
  reason: string,
  closeToken: (token: TokenRecord) => void
): number {
  let closed = 0
  const generations = new Set(
    Array.from(tokens.values(), (token) => token.identity.providerGeneration)
  )
  for (const providerGeneration of generations) {
    closed += closeSourceGeneration(tokens, reservations, providerGeneration, reason, closeToken)
  }
  return closed
}

export function closeSourceToken(
  token: TokenRecord,
  tokens: Map<string, TokenRecord>,
  closedSnapshots: Map<string, SshPtySourceTokenSnapshot>,
  reservations: Map<string, ReservationRecord>,
  spanOwners: Map<string, SpanRecord>,
  onTokenClosed: (identity: PtySourceDeliveryIdentity) => void
): void {
  token.state = 'closed'
  releaseSourceTokenSpans(token, spanOwners)
  releaseSourceTokenReservations(token, reservations)
  const key = ptySourceDeliveryKey(token.identity)
  tokens.delete(key)
  closedSnapshots.set(key, snapshotSourceToken(token))
  while (closedSnapshots.size > CLOSED_SOURCE_TOKEN_TOMBSTONE_LIMIT) {
    closedSnapshots.delete(closedSnapshots.keys().next().value!)
  }
  onTokenClosed(token.identity)
}
