import {
  NotificationPermissionPayloadSchema,
  NotificationPermissionResultSchema,
  NotificationPreferencePayloadSchema,
  NotificationPreferenceResultSchema,
  OpenSystemSettingsPayloadSchema,
  OpenSystemSettingsResultSchema
} from '../../shared/mobile-web/settings-device-contract'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebSettingsDeviceClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}
  permission(request = false) {
    return this.requests.request(
      'native',
      'notificationPermission',
      { request },
      NotificationPermissionPayloadSchema,
      NotificationPermissionResultSchema,
      request ? { timeoutMs: 2_147_483_647 } : undefined
    )
  }
  preference(enabled?: boolean) {
    return this.requests.request(
      'native',
      'notificationPreference',
      enabled === undefined ? {} : { enabled },
      NotificationPreferencePayloadSchema,
      NotificationPreferenceResultSchema
    )
  }
  openSettings() {
    return this.requests.request(
      'native',
      'openSystemSettings',
      {},
      OpenSystemSettingsPayloadSchema,
      OpenSystemSettingsResultSchema
    )
  }
}
