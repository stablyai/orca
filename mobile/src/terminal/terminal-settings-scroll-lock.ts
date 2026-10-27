import type { RefObject } from 'react'
import type { ScrollView } from 'react-native'

// Keep platform splitting outside expo-router routes; RN Web refs lack setNativeProps and need DOM scroll locking.
export function setTerminalSettingsScrollEnabled(
  ref: RefObject<ScrollView | null>,
  enabled: boolean
): void {
  ref.current?.setNativeProps({ scrollEnabled: enabled })
}
