import { Linking } from 'react-native'
import {
  ensureNotificationPermissions,
  getNotificationPermissionState
} from '../notifications/notification-permissions'
import { loadPushNotificationsEnabled, savePushNotificationsEnabled } from '../storage/preferences'
import type { NotificationSettingsOperations } from './notification-settings-operations'

export const nativeNotificationSettingsOperations: NotificationSettingsOperations = {
  async permission(request) {
    if (request) {
      await ensureNotificationPermissions()
    }
    return getNotificationPermissionState()
  },
  async preference(enabled) {
    if (enabled !== undefined) {
      await savePushNotificationsEnabled(enabled)
    }
    return { enabled: await loadPushNotificationsEnabled() }
  },
  openSettings: () => Linking.openSettings()
}
