import type { MobilePushToken } from './push-token'

/**
 * Web sibling: the page holds no device push token and cannot register one — the token is the
 * shell's and the gateway has no page client. The import is the defect, not the calls, which are
 * already inert here: `expo-notifications` runs `DevicePushTokenAutoRegistration.fx` at import,
 * which reads the persisted registration behind a `typeof localStorage === 'undefined'` guard that
 * Android's DOM-storage-off WebView walks through with `null`, raising on `.getItem`.
 */
export const getDevicePushToken = (): Promise<MobilePushToken | null> => Promise.resolve(null)

export function addPushTokenListener(_listener: (token: MobilePushToken) => void): () => void {
  return () => {}
}
