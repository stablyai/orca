import type { RefObject } from 'react'
import type { ScrollViewInstance } from 'react-native'

// Keep platform splitting outside expo-router routes; RN Web refs lack setNativeProps and need DOM scroll locking.
export function setTerminalSettingsScrollEnabled(
  ref: RefObject<ScrollViewInstance | null>,
  enabled: boolean
): void {
  ref.current?.setNativeProps({ scrollEnabled: enabled })
}
