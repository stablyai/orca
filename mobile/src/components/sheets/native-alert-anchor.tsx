import { Text } from '@expo/ui/swift-ui'

// The alert draws in its own window; its host only needs a view to present from.
export const NATIVE_ALERT_HOST_STYLE = { position: 'absolute', width: 1, height: 1 } as const

/** SwiftUI presents an alert only from a view in the hierarchy, so this stands in for one. */
export function NativeAlertAnchor() {
  return <Text> </Text>
}
