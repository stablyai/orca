import { Platform } from 'react-native'

/** The OS a screen's keyboard and inset arithmetic is for. Natively, the one it runs on. */
export type HostOs = 'ios' | 'android' | 'windows' | 'macos' | 'web'

export function hostOs(): HostOs {
  return Platform.OS
}
