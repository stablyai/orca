import type { RefObject } from 'react'
import type { ScrollView } from 'react-native'

/**
 * Why the write is imperative at all is at the call site. This exists to have a `.web.ts` sibling:
 * on RN Web a ScrollView ref is the DOM node, where `setNativeProps` is a `TypeError`, and a route
 * file cannot carry the split itself because expo-router reads a `.web.tsx` as a second route.
 */
export function setTerminalSettingsScrollEnabled(
  ref: RefObject<ScrollView | null>,
  enabled: boolean
): void {
  ref.current?.setNativeProps({ scrollEnabled: enabled })
}
