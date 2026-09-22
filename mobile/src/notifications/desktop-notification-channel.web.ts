/**
 * Web sibling: the page creates no Android notification channel, and must not import the module
 * that would.
 *
 * The native file is already a no-op off Android, so this changes the import rather than the
 * behaviour — and the import is the defect. See `push-token.web.ts` beside it for what
 * `expo-notifications` does at import inside the shell's WebView.
 */
export const DESKTOP_NOTIFICATION_CHANNEL_ID = 'orca-desktop'

export const ensureDesktopNotificationChannel = (): Promise<void> => Promise.resolve()
