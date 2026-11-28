import { translate } from '../../i18n/mobile-i18n'

export type NotificationReplyFailureReason = 'unconfirmed' | 'refused' | 'unreachable'
export class NotificationReplyFailure extends Error {
  constructor(readonly reason: NotificationReplyFailureReason) {
    super(reason)
  }
}

export function notificationReplyFailureMessage(reason: string): string {
  if (reason === 'unconfirmed' || reason.startsWith('Delivery unconfirmed')) {
    return translate(
      'notifications.reply.unconfirmed',
      'Delivery unconfirmed; check the chat before sending again'
    )
  }
  if (reason === 'refused') {
    return translate(
      'notifications.reply.refused',
      'The host refused the reply. Check the chat before sending again.'
    )
  }
  return translate(
    'notifications.reply.unreachable',
    'The host could not be reached. Your reply was saved.'
  )
}
