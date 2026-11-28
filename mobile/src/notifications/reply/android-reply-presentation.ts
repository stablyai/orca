import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import { requireOptionalNativeModule } from 'expo-modules-core'
import {
  NOTIFICATION_REPLY_ACTION,
  NOTIFICATION_REPLY_CATEGORY
} from '../../../../src/shared/notifications/notification-reply'
import { translate } from '../../i18n/mobile-i18n'

export async function ensureAndroidReplyCategory(): Promise<void> {
  if (Platform.OS !== 'android' || Platform.Version < 24) {
    return
  }
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
  const prompt = (await Notifications.getNotificationCategoriesAsync()).find(
    (category) => category.identifier === 'orca.prompt'
  )
  if (prompt) {
    await Notifications.setNotificationCategoryAsync(
      prompt.identifier,
      [
        ...prompt.actions.filter(
          (item) => item.identifier !== NOTIFICATION_REPLY_ACTION && item.identifier !== 'reply'
        ),
        action
      ],
      prompt.options
    )
  }
}

export async function showAndroidReplySent(
  response: Notifications.NotificationResponse
): Promise<void> {
  if (Platform.OS !== 'android') {
    return
  }
  const { identifier } = response.notification.request
  const presentation = requireOptionalNativeModule<{
    showReplySent(identifier: string, text: string): Promise<void>
  }>('OrcaNotificationReplyPresentation')
  const text =
    'userText' in response && typeof response.userText === 'string' ? response.userText : ''
  await presentation?.showReplySent(identifier, text)
}
