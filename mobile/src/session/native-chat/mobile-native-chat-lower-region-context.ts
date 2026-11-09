import { createContext, useContext, useLayoutEffect, useRef } from 'react'
import type { View } from 'react-native'

export type MobileNativeChatLowerRegion = {
  getViewport: () => unknown
  getContent: () => unknown
  getRoot: () => unknown
  reveal: (group?: unknown, reason?: 'focus' | 'edit' | 'menu') => void
  layoutChanged: () => void
}

export const MobileNativeChatLowerRegionContext = createContext<MobileNativeChatLowerRegion | null>(
  null
)

export function useMobileNativeChatLowerRegion(): MobileNativeChatLowerRegion | null {
  return useContext(MobileNativeChatLowerRegionContext)
}

export const MobileNativeChatLowerGeometryContext = createContext<{
  viewportHeight: number
  allocationHeight: number | null
}>({
  viewportHeight: 0,
  allocationHeight: null
})

export const MobileNativeChatComposerPresenceContext = createContext(true)

export function useMobileNativeChatLowerGeometry() {
  return useContext(MobileNativeChatLowerGeometryContext)
}

export function useMobileNativeChatComposerRegion(shown: boolean, focused: boolean) {
  const groupRef = useRef<View>(null)
  const lowerRegion = useMobileNativeChatLowerRegion()
  const menuWasShown = useRef(false)
  useLayoutEffect(() => {
    lowerRegion?.layoutChanged()
    if (shown !== menuWasShown.current && focused) {
      lowerRegion?.reveal(groupRef.current, shown ? 'menu' : 'edit')
    }
    menuWasShown.current = shown
  })
  return groupRef
}
