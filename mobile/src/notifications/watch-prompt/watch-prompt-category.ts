import { Platform } from 'react-native'
import * as Notifications from 'expo-notifications'
import {
  WATCH_PROMPT_ALLOW_ACTION,
  WATCH_PROMPT_CATEGORY,
  WATCH_PROMPT_DENY_ACTION
} from '../../../../src/shared/notifications/watch-prompt-reply'

/** Registers the Allow/Deny actions Apple Watch mirrors from this phone. */
export function registerWatchPromptCategory(): Promise<void> {
  // Background actions keep the phone closed. iOS may drop one if the app was force-quit.
  if (Platform.OS !== 'ios') {
    return Promise.resolve()
  }
  return Notifications.setNotificationCategoryAsync(WATCH_PROMPT_CATEGORY, [
    {
      identifier: WATCH_PROMPT_ALLOW_ACTION,
      buttonTitle: 'Allow',
      options: { opensAppToForeground: false, isAuthenticationRequired: true }
    },
    {
      identifier: WATCH_PROMPT_DENY_ACTION,
      buttonTitle: 'Deny',
      options: {
        opensAppToForeground: false,
        isDestructive: true,
        isAuthenticationRequired: true
      }
    }
  ]).then(() => undefined)
}
