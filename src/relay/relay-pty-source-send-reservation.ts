import type { PtySourceDeliveryIdentity, PtySourceSpan } from '../shared/pty-source-credit-contract'
import type { RelayDispatcher } from './dispatcher'
import type { PtySourceSendReservation } from './pty-source-credit-record'
import type { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

const PTY_SOURCE_FRAME_MAX_SU = 16 * 1024

/** Reserve one credited source span, accounting for the optional transfer envelope. */
export function reservePtySourceSend(args: {
  dispatcher: RelayDispatcher
  session: SshPtyConsumerSessionAdapter
  identity: PtySourceDeliveryIdentity
  clientId: number
}): PtySourceSendReservation | null {
  const snapshot = args.session.sourceDeliverySnapshot(args.identity)
  const encodedDataBudget = args.dispatcher.producerDataBudget(
    'pty.data',
    {
      ...sourceFrameParams(args.identity),
      rawLength: PTY_SOURCE_FRAME_MAX_SU,
      transformed: false,
      sourceEndSu: snapshot.receivedEndSu,
      sourceLengthSu: PTY_SOURCE_FRAME_MAX_SU
    },
    args.clientId
  )
  const maxSourceSu = Math.min(
    PTY_SOURCE_FRAME_MAX_SU,
    Math.max(1, Math.floor(Math.max(0, encodedDataBudget - 32) / 6))
  )
  let reservation = args.session.reserveSourceSend(args.identity, maxSourceSu)
  if (!reservation || !reservation.span.ownershipTransfer) {
    return reservation
  }
  const envelopeBudget = args.dispatcher.producerDataBudget(
    'pty.data',
    {
      ...sourceFrameParams(args.identity, reservation.span),
      rawLength: reservation.span.transform.rawLengthSu,
      transformed: reservation.span.transform.transformed,
      sourceEndSu: reservation.span.sourceEndSu,
      sourceLengthSu: reservation.span.sourceEndSu - reservation.span.sourceStartSu
    },
    args.clientId
  )
  const envelopeMaxSourceSu = Math.min(
    PTY_SOURCE_FRAME_MAX_SU,
    Math.max(0, Math.floor(Math.max(0, envelopeBudget - 32) / 6))
  )
  if (envelopeMaxSourceSu <= 0) {
    args.session.rollbackSourceSend(reservation)
    return null
  }
  if (reservation.span.sourceEndSu - reservation.span.sourceStartSu > envelopeMaxSourceSu) {
    args.session.rollbackSourceSend(reservation)
    reservation = args.session.reserveSourceSend(args.identity, envelopeMaxSourceSu)
    if (
      reservation &&
      reservation.span.sourceEndSu - reservation.span.sourceStartSu > envelopeMaxSourceSu
    ) {
      args.session.rollbackSourceSend(reservation)
      return null
    }
  }
  return reservation
}

export function sourceFrameParams(
  identity: PtySourceDeliveryIdentity,
  span: Pick<PtySourceSpan, 'ownershipTransfer'> = {}
): Record<string, unknown> {
  return {
    id: identity.id,
    deliveryToken: identity.deliveryToken,
    clientGeneration: identity.clientGeneration,
    ownerGeneration: identity.ownerGeneration,
    ptyIncarnation: identity.ptyIncarnation,
    ...(span.ownershipTransfer ? { ownershipTransfer: span.ownershipTransfer } : {})
  }
}
