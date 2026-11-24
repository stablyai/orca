import type { MobilePushToken } from './push-token'

// Keep Expo notifications out of the page import graph: its undefined-only localStorage guard misses Android’s disabled-storage null. Native owns the device token; pages never register.
export const getDevicePushToken = (): Promise<MobilePushToken | null> => Promise.resolve(null)

export function addPushTokenListener(_listener: (token: MobilePushToken) => void): () => void {
  return () => {}
}
