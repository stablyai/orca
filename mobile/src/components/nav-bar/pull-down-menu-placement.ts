import type { EdgeInsets } from 'react-native-safe-area-context'

const MENU_WIDTH = 252
const ANCHOR_GAP = 6
const EDGE_INSET = 8

type AnchorBox = { x: number; y: number; width: number; height: number }

/** Below the button, or above it when the button sits in the lower half. */
export type PullDownMenuPlacement = { left: number; width: number; maxHeight: number } & (
  | { top: number }
  | { bottom: number }
)

/** Right-aligned to the button, then kept inside the window's safe area. */
export function placePullDownMenu(args: {
  anchor: AnchorBox
  window: { width: number; height: number }
  insets: EdgeInsets
}): PullDownMenuPlacement {
  const { anchor, window, insets } = args
  const minLeft = insets.left + EDGE_INSET
  const maxRight = window.width - insets.right - EDGE_INSET
  const width = Math.max(0, Math.min(MENU_WIDTH, maxRight - minLeft))
  const left = Math.max(minLeft, Math.min(anchor.x + anchor.width - width, maxRight - width))
  // Long menus scroll instead of running off a short (landscape) screen.
  if (anchor.y + anchor.height / 2 > window.height / 2) {
    const bottom = window.height - anchor.y + ANCHOR_GAP
    return {
      left,
      width,
      bottom,
      maxHeight: Math.max(0, window.height - bottom - insets.top - EDGE_INSET)
    }
  }
  const top = anchor.y + anchor.height + ANCHOR_GAP
  return {
    left,
    width,
    top,
    maxHeight: Math.max(0, window.height - top - insets.bottom - EDGE_INSET)
  }
}
