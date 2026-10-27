import { Platform } from 'react-native'

export type HostOs = 'ios' | 'android' | 'windows' | 'macos' | 'web'

export function hostOs(): HostOs {
  return Platform.OS
}
