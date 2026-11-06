import * as Notifications from 'expo-notifications'
import type {
  MobilePushApnsEnvironment,
  MobilePushPlatform
} from '../../../src/shared/mobile-push-contract'

// Use raw APNs/FCM tokens because Orca’s gateway talks directly to providers, not Expo’s push service.

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
  return raw.type === 'android' ? { platform: 'android', token: raw.data } : null
}

export async function getDevicePushToken(): Promise<MobilePushToken | null> {
  try {
    return toMobilePushToken(await Notifications.getDevicePushTokenAsync())
  } catch {
    return null
  }
}

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
    // Unavailable optional push must not throw from the root subscription effect.
    return () => {}
  }
}
