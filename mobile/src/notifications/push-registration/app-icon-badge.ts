import * as Notifications from 'expo-notifications'

export function clearAppIconBadge(): void {
  void Notifications.setBadgeCountAsync(0).catch(() => undefined)
}
