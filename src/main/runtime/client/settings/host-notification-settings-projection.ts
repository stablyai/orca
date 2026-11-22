import { getDefaultNotificationSettings } from '../../../../shared/notifications/notification-settings-defaults'
import type { NotificationSettings } from '../../../../shared/notifications/notification-settings-types'

export function projectHostNotificationSettings(
  settings: NotificationSettings = getDefaultNotificationSettings()
): {
  enabled: boolean
  agentTaskComplete: boolean
  agentNeedsInput: boolean
  terminalBell: boolean
} {
  const { enabled, agentTaskComplete, agentNeedsInput, terminalBell } = settings
  return { enabled, agentTaskComplete, agentNeedsInput, terminalBell }
}
