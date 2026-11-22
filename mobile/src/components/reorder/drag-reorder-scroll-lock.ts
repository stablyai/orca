import type { RefObject } from 'react'
import type { ScrollViewInstance } from 'react-native'

// A held row stops its ScrollView scrolling; RN Web refs lack setNativeProps and need DOM scroll locking.
export function setDragReorderScrollEnabled(
  ref: RefObject<ScrollViewInstance | null>,
  enabled: boolean
): void {
  ref.current?.setNativeProps({ scrollEnabled: enabled })
}
