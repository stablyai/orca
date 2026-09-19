import { useEffect, useState } from 'react'

/**
 * Web sibling: the keyboard's height as the browser reports it, which is not as an event.
 *
 * react-native-web's `Keyboard` is a stub whose `addListener` returns a subscription that never
 * fires, so every screen waiting for `keyboardDidShow` inside the shell's page waits forever and
 * the software keyboard covers whatever is at the bottom of the document. What the browser does
 * publish is `visualViewport`: the layout viewport stays the size it was and the visual viewport
 * shrinks to the part still on screen.
 *
 * So the occluded strip is what the visual viewport leaves uncovered at the bottom —
 * `innerHeight - (height + offsetTop)`. `offsetTop` is in it because a pinch-zoomed or scrolled
 * visual viewport sits partway down the layout viewport, and without it the strip below would be
 * counted as keyboard.
 *
 * `resize` and `scroll` both, on the visual viewport rather than the window: the keyboard opening
 * is a resize, and the browser scrolling the focused input into view is a scroll that moves
 * `offsetTop` without resizing anything.
 *
 * No `visualViewport` at all is 0 rather than a guess. It is the answer for a document that cannot
 * be occluded by a keyboard it has no way to see.
 */
function occlusion(viewport: VisualViewport | undefined): number {
  if (viewport === undefined) {
    return 0
  }
  return Math.max(0, window.innerHeight - (viewport.height + viewport.offsetTop))
}

export function useKeyboardOcclusion(): number {
  const [keyboardLift, setKeyboardLift] = useState(0)

  useEffect(() => {
    const viewport = window.visualViewport ?? undefined
    if (viewport === undefined) {
      return
    }
    const read = (): void => setKeyboardLift(occlusion(viewport))
    // Read once on mount: a composer opened while the keyboard is already up gets no event at all.
    read()
    viewport.addEventListener('resize', read)
    viewport.addEventListener('scroll', read)

    return () => {
      viewport.removeEventListener('resize', read)
      viewport.removeEventListener('scroll', read)
    }
  }, [])

  return keyboardLift
}

/**
 * On the web the padding is the whole of the avoidance: `KeyboardAvoidingView` is driven by the
 * `Keyboard` events this file exists because the page never receives.
 */
export function useKeyboardAvoidingPadding(): number {
  return useKeyboardOcclusion()
}
