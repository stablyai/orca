import { isRpcDeliveryUnknown } from '../../transport/rpc/rpc-delivery-ambiguity'

export type NotificationReplyFailureReason = 'unconfirmed' | 'refused' | 'unreachable'
export class NotificationReplyFailure extends Error {
  constructor(readonly reason: NotificationReplyFailureReason) {
    super(reason)
  }
}

export function notificationReplyFailureReason(error: unknown): NotificationReplyFailureReason {
  return isRpcDeliveryUnknown(error)
    ? 'unconfirmed'
    : error instanceof NotificationReplyFailure
      ? error.reason
      : 'unreachable'
}
