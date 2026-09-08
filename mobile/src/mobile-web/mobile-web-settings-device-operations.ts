import {
  NotificationPermissionPayloadSchema,
  NotificationPermissionResultSchema,
  NotificationPreferencePayloadSchema,
  NotificationPreferenceResultSchema,
  OpenSystemSettingsPayloadSchema
} from '../../../src/shared/mobile-web/settings-device-contract'
import type { NotificationSettingsOperations } from '../settings/notification-settings-operations'
import { MobileWebBrokerError } from './mobile-web-broker-error'

export async function executeSettingsDeviceOperation(
  operation: string,
  payload: unknown,
  authority?: NotificationSettingsOperations
): Promise<unknown> {
  if (operation === 'notificationPermission') {
    const parsed = NotificationPermissionPayloadSchema.parse(payload)
    if (!authority) {
      throw new MobileWebBrokerError('unavailable')
    }
    return NotificationPermissionResultSchema.parse(await authority.permission(parsed.request))
  }
  if (operation === 'notificationPreference') {
    const parsed = NotificationPreferencePayloadSchema.parse(payload)
    if (!authority) {
      throw new MobileWebBrokerError('unavailable')
    }
    return NotificationPreferenceResultSchema.parse(await authority.preference(parsed.enabled))
  }
  OpenSystemSettingsPayloadSchema.parse(payload)
  if (!authority) {
    throw new MobileWebBrokerError('unavailable')
  }
  await authority.openSettings()
  return null
}
