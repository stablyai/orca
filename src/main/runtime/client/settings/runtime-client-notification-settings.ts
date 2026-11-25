import { getDefaultNotificationSettings } from '../../../../shared/notifications/notification-settings-defaults'
import type { NotificationSettings } from '../../../../shared/notifications/notification-settings-types'
import type { RuntimeClientSettings } from './runtime-client-settings-shape'

export function projectHostNotificationSettings(
  settings: NotificationSettings = getDefaultNotificationSettings()
): RuntimeClientSettings['hostNotifications'] {
  const { enabled, agentTaskComplete, agentNeedsInput, terminalBell } = settings
  return { enabled, agentTaskComplete, agentNeedsInput, terminalBell }
}
