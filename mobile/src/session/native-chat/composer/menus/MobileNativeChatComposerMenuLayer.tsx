import type { ReactNode, RefObject } from 'react'
import type { HostInstance } from 'react-native'

export type ComposerMenuLayerProps = {
  anchorRef: RefObject<HostInstance | null>
  children: ReactNode
}

export function MobileNativeChatComposerMenuLayer({ children }: ComposerMenuLayerProps) {
  return children
}
