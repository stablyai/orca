import type { ReactNode, RefObject } from 'react'
import type { View } from 'react-native'

export type ComposerMenuLayerProps = {
  anchorRef: RefObject<View | null>
  children: ReactNode
}

export function MobileNativeChatComposerMenuLayer({ children }: ComposerMenuLayerProps) {
  return children
}
