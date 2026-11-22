import * as Notifications from 'expo-notifications'

// Hosts set the icon's count through their pushes; with none left registered, nothing would lower it.
export function clearAppIconBadge(): void {
  void Notifications.setBadgeCountAsync(0).catch(() => undefined)
}
