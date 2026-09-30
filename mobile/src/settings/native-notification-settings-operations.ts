import { Linking } from 'react-native'
import {
  ensureNotificationPermissions,
  getNotificationPermissionState
} from '../notifications/notification-permissions'
import { loadPushNotificationsEnabled } from '../storage/preferences'
import { setRemotePushEnabled } from '../notifications/push-registration'
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
      await setRemotePushEnabled(enabled)
    }
    return { enabled: await loadPushNotificationsEnabled() }
  },
  openSettings: () => Linking.openSettings()
}
