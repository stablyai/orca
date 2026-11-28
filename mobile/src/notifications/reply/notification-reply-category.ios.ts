import * as Notifications from 'expo-notifications'
import { translate } from '../../i18n/mobile-i18n'
import {
  NOTIFICATION_REPLY_ACTION,
  NOTIFICATION_REPLY_CATEGORY
} from '../../../../src/shared/notifications/notification-reply'

export async function ensureNotificationReplyCategory(): Promise<void> {
  const action: Notifications.NotificationAction = {
    identifier: NOTIFICATION_REPLY_ACTION,
    buttonTitle: translate('notifications.reply.action', 'Reply'),
    textInput: {
      submitButtonTitle: translate('notifications.reply.send', 'Send'),
      placeholder: translate('notifications.reply.placeholder', 'Message')
    },
    options: { opensAppToForeground: false }
  }
  await Notifications.setNotificationCategoryAsync(NOTIFICATION_REPLY_CATEGORY, [action])
}
