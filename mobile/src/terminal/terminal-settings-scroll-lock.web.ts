import type { RefObject } from 'react'
import type { ScrollView } from 'react-native'

// Clear inline overflowY to restore RN Web’s class-driven scrolling; touch-action alone would leave wheels/trackpads enabled.
export function setTerminalSettingsScrollEnabled(
  ref: RefObject<ScrollView | null>,
  enabled: boolean
): void {
  const node = ref.current
  if (node instanceof HTMLElement) {
    node.style.overflowY = enabled ? '' : 'hidden'
  }
}
