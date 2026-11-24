import type { NotificationPermissionState } from '../notifications/delivery-policy/notification-permissions'

export interface NotificationSettingsOperations {
  permission(request?: boolean): Promise<NotificationPermissionState>
  preference(enabled?: boolean): Promise<{ enabled: boolean }>
  openSettings(): Promise<unknown>
}
