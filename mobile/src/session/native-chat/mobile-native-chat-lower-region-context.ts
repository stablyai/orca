import { createContext, useContext } from 'react'

export type MobileNativeChatLowerRegion = {
  viewportHeight: number
  allocationHeight: number
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
