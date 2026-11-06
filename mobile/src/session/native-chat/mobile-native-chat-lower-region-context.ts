import { createContext, useContext } from 'react'

export type MobileNativeChatLowerRegion = {
  getViewport: () => unknown
  getContent: () => unknown
  getRoot: () => unknown
  reveal: (group?: unknown) => void
  layoutChanged: () => void
}

export const MobileNativeChatLowerRegionContext = createContext<MobileNativeChatLowerRegion | null>(
  null
)

export function useMobileNativeChatLowerRegion(): MobileNativeChatLowerRegion | null {
  return useContext(MobileNativeChatLowerRegionContext)
}

export const MobileNativeChatLowerGeometryContext = createContext({
  viewportHeight: 0,
  allocationHeight: 0
})

export const MobileNativeChatComposerPresenceContext = createContext(true)

export function useMobileNativeChatLowerGeometry() {
  return useContext(MobileNativeChatLowerGeometryContext)
}
