import { createContext, useContext } from 'react'

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

/** A prompt card sits under the queue: the queue closes its own box instead of tucking into a composer. */
export const MobileNativeChatQueueAbovePromptContext = createContext(false)

export function useMobileNativeChatLowerGeometry() {
  return useContext(MobileNativeChatLowerGeometryContext)
}
