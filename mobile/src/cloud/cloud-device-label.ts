import Constants from 'expo-constants'
import { Platform } from 'react-native'

/** How this phone appears in Orca Cloud's device list (the user's own device name when the OS shares it). */
export function cloudDeviceLabel(): string {
  const name = Constants.deviceName?.trim()
  if (name) {
    return name.slice(0, 64)
  }
  return Platform.OS === 'ios' ? 'iPhone' : Platform.OS === 'android' ? 'Android phone' : 'Browser'
}
