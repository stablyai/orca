import type { ViewStyle } from 'react-native'
import type { EdgeInsets } from 'react-native-safe-area-context'

/**
 * Padding that keeps the session sidebar clear of a released Duo side strip.
 * Standard phones, tablets, and Android (no released inset) get none.
 */
export function sessionSidebarSidePadding(args: {
  windowInsets: Pick<EdgeInsets, 'left' | 'right'>
  windowWidth: number
  frameWidth: number
  docked: boolean
  sidebarPeek: number
}): ViewStyle | null {
  const { windowInsets, windowWidth, frameWidth, docked, sidebarPeek } = args
  if (windowWidth <= 0 || frameWidth <= 0) {
    return null
  }
  const appliedHorizontal = Math.max(0, windowWidth - frameWidth)
  const released = Math.max(0, windowInsets.left + windowInsets.right - appliedHorizontal)
  if (released <= 0) {
    return null
  }
  if (windowInsets.right >= windowInsets.left) {
    return { paddingRight: Math.min(released, windowInsets.right) }
  }
  // On the left, the undocked card already peeks by sidebarPeek, so only the remainder clears the strip.
  const leftInset = Math.min(released, windowInsets.left)
  const extraLeft = docked ? 0 : Math.max(0, leftInset - sidebarPeek)
  return extraLeft > 0 ? { paddingLeft: extraLeft } : null
}
