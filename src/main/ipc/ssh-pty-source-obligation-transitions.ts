import type {
  SshPtySourceConsumerId,
  SshPtySourceObligationState
} from './ssh-pty-source-obligation-contract'
import {
  advanceSourceTerminalEnd,
  cancelOpenSourceObligations,
  requireSourceSpan,
  type SpanRecord,
  type TokenRecord
} from './ssh-pty-source-obligation-state'

export function applySourceRecoveryCancellationProof(
  token: TokenRecord,
  proof: Readonly<{ sentEndSu: number; creditedEndSu: number }>
): void {
  if (
    token.state !== 'active' ||
    proof.sentEndSu < token.receivedEndSu ||
    proof.creditedEndSu !== token.ackPublishedEndSu ||
    proof.creditedEndSu > token.receivedEndSu
  ) {
    throw new Error('SSH PTY source recovery cancellation proof is stale or invalid')
  }
  cancelOpenSourceObligations(token, 'relay-recovery-cancellation-proof')
}

export function transitionOpenSourceObligation(
  spanOwners: ReadonlyMap<string, SpanRecord>,
  spanId: string,
  consumer: SshPtySourceConsumerId,
  next: SshPtySourceObligationState
): boolean {
  const { token, span } = requireSourceSpan(spanOwners, spanId)
  if (span.obligations.get(consumer)?.state !== 'open') {
    return false
  }
  span.obligations.set(consumer, next)
  advanceSourceTerminalEnd(token)
  return true
}

export function commitSourceObligationTransfer(
  spanOwners: ReadonlyMap<string, SpanRecord>,
  spanId: string,
  consumer: SshPtySourceConsumerId
): boolean {
  const { token, span } = requireSourceSpan(spanOwners, spanId)
  const current = span.obligations.get(consumer)
  if (current?.state !== 'transferring') {
    return false
  }
  span.obligations.set(
    consumer,
    Object.freeze({ state: 'transferred', to: current.to, reason: current.reason })
  )
  advanceSourceTerminalEnd(token)
  return true
}

export function cancelSourceObligationTransfer(
  spanOwners: ReadonlyMap<string, SpanRecord>,
  spanId: string,
  consumer: SshPtySourceConsumerId,
  reason: string
): boolean {
  const { token, span } = requireSourceSpan(spanOwners, spanId)
  if (span.obligations.get(consumer)?.state !== 'transferring') {
    return false
  }
  span.obligations.set(consumer, Object.freeze({ state: 'canceled', reason }))
  advanceSourceTerminalEnd(token)
  return true
}

export function rollbackSourceObligationTransfer(
  spanOwners: ReadonlyMap<string, SpanRecord>,
  spanId: string,
  consumer: SshPtySourceConsumerId
): boolean {
  const { span } = requireSourceSpan(spanOwners, spanId)
  if (span.obligations.get(consumer)?.state !== 'transferring') {
    return false
  }
  span.obligations.set(consumer, Object.freeze({ state: 'open' }))
  return true
}

export function modelAcceptedSourceEnd(token: TokenRecord): number {
  let acceptedEndSu = token.ackPublishedEndSu
  for (const record of token.spans) {
    if (
      record.span.sourceStartSu !== acceptedEndSu ||
      record.obligations.get('model')?.state !== 'settled'
    ) {
      break
    }
    acceptedEndSu = record.span.sourceEndSu
  }
  return acceptedEndSu
}
