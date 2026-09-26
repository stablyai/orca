import { useEffect } from 'react'
import type { BridgeSafeAreaInsets } from './bridge/bridge-safe-area-insets'

/**
 * The part of an edge-to-edge WebView that sits under a system bar, which is what the page pads for.
 *
 * The window's insets, as a native screen reads them with the keyboard covering it, except where
 * the shell stands over the view: an older page's view it ends at the keyboard's top has nothing
 * under the gesture bar, and a banner above the view takes the status bar strip itself.
 */
export function pageSafeAreaInsets(input: {
  insets: BridgeSafeAreaInsets
  viewShortenedBy: number
  topCovered: boolean
}): BridgeSafeAreaInsets {
  const { insets } = input
  return {
    top: input.topCovered ? 0 : insets.top,
    right: insets.right,
    bottom: input.viewShortenedBy > 0 ? 0 : insets.bottom,
    left: insets.left
  }
}

/** Hands moved insets to the page over the re-sent `init` a pane move takes: a shortened view, a
 *  rotation, or the shell's banner. Keyed on the four numbers, so a render moves nothing. */
export function usePublishedSafeAreaInsets(
  publish: (insets: BridgeSafeAreaInsets) => void,
  insets: BridgeSafeAreaInsets
): void {
  const { top, right, bottom, left } = insets
  useEffect(() => {
    publish({ top, right, bottom, left })
  }, [publish, top, right, bottom, left])
}
