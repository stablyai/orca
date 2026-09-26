import { useEffect } from 'react'
import type { BridgeSafeAreaInsets } from './bridge/bridge-safe-area-insets'

/**
 * The part of an edge-to-edge WebView that sits under a system bar, which is what the page pads for.
 *
 * Not the window's insets as they are: with the keyboard up the shell already ends the view at the
 * keyboard's top, so nothing of the page is under the gesture bar, and a banner the shell draws above
 * the view takes the status bar strip itself.
 */
export function pageSafeAreaInsets(input: {
  insets: BridgeSafeAreaInsets
  keyboardInset: number
  topCovered: boolean
}): BridgeSafeAreaInsets {
  const { insets } = input
  return {
    top: input.topCovered ? 0 : insets.top,
    right: insets.right,
    bottom: input.keyboardInset > 0 ? 0 : insets.bottom,
    left: insets.left
  }
}

/** Hands moved insets to the page over the re-sent `init` a pane move takes: the keyboard, a
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
