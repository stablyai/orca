import type { ReactNode, RefObject } from 'react'
import type { View } from 'react-native'

export function MobileNativeChatComposerMenuLayer({
  children
}: {
  anchorRef: RefObject<View | null>
  children: ReactNode
}) {
  return children
}
