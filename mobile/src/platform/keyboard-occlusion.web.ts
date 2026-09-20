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
 * A pinch zoom is not a keyboard, and geometry alone cannot tell them apart: a 2x zoom shrinks the
 * visual viewport by exactly as much as a half-screen keyboard. So a `scale` other than 1 answers
 * 0, and what makes that affordable is that the ordinary typing path never gets there. iOS zooms
 * on focus of any input under 16px and does not zoom back out, so on a 14px input every focus
 * would arrive zoomed and this guard would refuse the one flow the seam exists for. The fix is at
 * the input rather than here: `text-input-font-size.web.ts` raises both consumers to the floor, so
 * a scale other than 1 means a user pinched, and a keyboard raised during one is the rare case
 * that costs. `maximum-scale=1` on the viewport meta would have done it too and was rejected —
 * Android WebView honours it, so it would have taken pinch zoom from low-vision users to fix a
 * problem only iOS has.
 *
 * `scale` is read defensively because older WebViews do not implement it, and treating its absence
 * as zoomed would answer 0 for every keyboard on them.
 *
 * No `visualViewport` at all is 0 rather than a guess — that guard is in the effect below, which
 * is also the only thing that can act on it, and a second copy here was unreachable.
 */
function occlusion(viewport: VisualViewport): number {
  if ((viewport.scale ?? 1) !== 1) {
    return 0
  }
  return Math.max(0, window.innerHeight - (viewport.height + viewport.offsetTop))
}

export function useKeyboardOcclusion(): number {
  const [keyboardLift, setKeyboardLift] = useState(0)

  useEffect(() => {
    // Both shapes: `null` is what the DOM declares, `undefined` is a WebView without the property.
    const viewport = window.visualViewport
    if (viewport === null || viewport === undefined) {
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
