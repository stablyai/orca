import type { ReactNode, RefObject } from 'react'
import type { View } from 'react-native'
import type { ComposerMenuIntrinsicSize } from './mobile-native-chat-composer-menu-size'

export type ComposerMenuLayerProps = {
  anchorRef: RefObject<View | null>
  reserveRef?: RefObject<View | null>
  onActiveChange?: (active: boolean) => void
  onIntrinsic?: (size: ComposerMenuIntrinsicSize) => void
  children: ReactNode
}

export function MobileNativeChatComposerMenuLayer({ children }: ComposerMenuLayerProps) {
  return children
}
