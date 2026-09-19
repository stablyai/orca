import { samePtySourceDelivery } from '../../shared/pty-source-credit-contract'
import { assertNonNegativeSafeInteger } from '../../shared/pty-source-credit-validation'
import type { ReservationRecord, TokenRecord } from './ssh-pty-source-obligation-state'

/** Local delivery evidence only; neither a host ACK receipt nor durable route retirement. */
export function requireLiveSshPtyOutputSettlement(
  token: TokenRecord,
  reservations: Iterable<ReservationRecord>,
  expectedEndSu: number
) {
  assertNonNegativeSafeInteger(expectedEndSu, 'expectedEndSu')
  if (
    token.state !== 'active' ||
    token.generationClosed ||
    token.exitPublished ||
    token.canceledObligations ||
    token.receivedEndSu !== expectedEndSu ||
    token.obligationsTerminalEndSu !== expectedEndSu ||
    token.ackQueuedEndSu !== expectedEndSu ||
    token.ackPublishedEndSu !== expectedEndSu ||
    token.spans.length !== 0
  ) {
    throw new Error('ssh_live_output_settlement_unavailable')
  }
  for (const { reservation } of reservations) {
    if (samePtySourceDelivery(reservation.span, token.identity)) {
      throw new Error('ssh_live_output_settlement_admission_pending')
    }
  }
  const {
    id,
    providerGeneration,
    clientGeneration,
    ownerGeneration,
    ptyIncarnation,
    deliveryToken
  } = token.identity
  return Object.freeze({
    id,
    providerGeneration,
    clientGeneration,
    ownerGeneration,
    ptyIncarnation,
    deliveryToken,
    fromSourceEndSu: token.checkpointSourceEndSu,
    throughSourceEndSu: expectedEndSu
  })
}
