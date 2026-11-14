import type { ReactNode, RefObject } from 'react'
import type { HostInstance, TextInputInstance } from 'react-native'
import type { ComposerMenuIntrinsicSize } from './mobile-native-chat-composer-menu-size'

export type ComposerAllocationProps = {
  anchorRef: RefObject<HostInstance | null>
  fieldRef: RefObject<TextInputInstance | null>
  hasMenu: boolean
  children: ReactNode
}

export function MobileNativeChatComposerAllocation({ children }: ComposerAllocationProps) {
  return children
}

export function MobileNativeChatComposerMenuReservation() {
  return null
}

export type ComposerAllocation = {
  reserveRef: RefObject<HostInstance | null>
  reservation: number
  fieldMaxHeight: number | undefined
  onActiveChange: (active: boolean) => void
  onIntrinsic: (size: ComposerMenuIntrinsicSize) => void
}

export function useMobileNativeChatComposerAllocation(): ComposerAllocation | null {
  return null
}
