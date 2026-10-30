import type { LiveAlertsNativeAdapter } from './live-alert-types'

// Live Updates are Android notifications: iOS, the web page and unit tests get no adapter, and
// none of them loads the native module. live-alerts-native.android.ts is the Android adapter.
export const liveAlertsNative: LiveAlertsNativeAdapter | null = null
