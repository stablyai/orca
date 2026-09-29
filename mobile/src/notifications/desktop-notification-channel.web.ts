/**
 * Web sibling: the page creates no Android notification channel and cannot register push. The
 * native file already returns early off Android, so what this changes is the import: it reaches
 * `expo-notifications`, which at import reads the persisted registration behind a
 * `typeof localStorage === 'undefined'` guard that the shell's DOM-storage-off WebView walks
 * through with `null`, raising on `.getItem`. See `push-token.web.ts` beside it.
 */
export const DESKTOP_NOTIFICATION_CHANNEL_ID = 'orca-desktop'

export const ensureDesktopNotificationChannel = (): Promise<void> => Promise.resolve()
