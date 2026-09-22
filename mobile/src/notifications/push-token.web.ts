import type { MobilePushToken } from './push-token'

/**
 * Web sibling: the page holds no device push token, and importing the module that reads one is
 * what broke the document.
 *
 * `expo-notifications` is not a module a browser can merely import. Its
 * `DevicePushTokenAutoRegistration.fx` runs at import: it adds a push-token listener, which React
 * Native Web answers with a warning and an inert subscription, and it reads the persisted server
 * registration out of `window.localStorage`. That read is guarded by
 * `typeof localStorage === 'undefined'`, and Android's WebView with DOM storage off answers `null`
 * rather than leaving it undefined, so the guard passes and the read raises
 * "Cannot read properties of null (reading 'getItem')" — an error-level line on every page load,
 * from a subsystem the page cannot use. Push registration is the app's: it needs a device token
 * the shell owns and a gateway the page has no client for.
 *
 * The native file's own calls are already inert here — both are wrapped in `try`/`catch` and a
 * browser's `getDevicePushTokenAsync` answers a web token this app has no gateway path for — so
 * what this sibling changes is the import and not a behaviour.
 */
export const getDevicePushToken = (): Promise<MobilePushToken | null> => Promise.resolve(null)

export function addPushTokenListener(_listener: (token: MobilePushToken) => void): () => void {
  return () => {}
}
