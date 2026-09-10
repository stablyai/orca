import * as Notifications from 'expo-notifications'
import type {
  MobilePushApnsEnvironment,
  MobilePushPlatform
} from '../../../src/shared/mobile-push-contract'

// Why: the native APNs/FCM token, not an Expo push token — Orca's own gateway
// talks to Apple and Google directly, so it needs the raw device token.

export type MobilePushToken = {
  readonly platform: MobilePushPlatform
  readonly token: string
  readonly apnsEnvironment?: MobilePushApnsEnvironment
}

// Dev-client builds are debug and get sandbox APNs; TestFlight and App Store are release.
function apnsEnvironment(): MobilePushApnsEnvironment {
  return typeof __DEV__ !== 'undefined' && __DEV__ ? 'sandbox' : 'production'
}

function toMobilePushToken(raw: { type: string; data: unknown }): MobilePushToken | null {
  if (typeof raw.data !== 'string' || raw.data.length === 0) {
    return null
  }
  if (raw.type === 'ios') {
    return { platform: 'ios', token: raw.data, apnsEnvironment: apnsEnvironment() }
  }
  // Web tokens carry an object payload and no Orca gateway path; only native counts.
  return raw.type === 'android' ? { platform: 'android', token: raw.data } : null
}

/**
 * The device's native push token, or null when this build cannot have one —
 * a simulator, a de-Googled Android device, or a shell without the entitlement.
 */
export async function getDevicePushToken(): Promise<MobilePushToken | null> {
  try {
    return toMobilePushToken(await Notifications.getDevicePushTokenAsync())
  } catch {
    return null
  }
}

/** Providers can roll a token while the app runs; the old one stops delivering. */
export function addPushTokenListener(listener: (token: MobilePushToken) => void): () => void {
  try {
    const subscription = Notifications.addPushTokenListener((raw) => {
      const token = toMobilePushToken(raw)
      if (token) {
        listener(token)
      }
    })
    return () => subscription.remove()
  } catch {
    // A shell with no push capability cannot subscribe; the caller is a root-level
    // effect, so throwing here would take the whole app down over an optional feature.
    return () => {}
  }
}
