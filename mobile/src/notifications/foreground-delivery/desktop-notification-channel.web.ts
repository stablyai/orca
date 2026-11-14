// Do not import Expo notifications into the page: its undefined-only localStorage guard misses Android’s disabled-storage null and throws on getItem. Native owns channel/push registration.
export const DESKTOP_NOTIFICATION_CHANNEL_ID = 'orca-desktop'

export const ensureDesktopNotificationChannel = (): Promise<void> => Promise.resolve()
