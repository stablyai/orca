import { useEffect, useState } from 'react'

/** The height the shell last said over the bridge, and a way to hear it move. */
export type ShellKeyboardSource = {
  read: () => number
  subscribe: (listener: (height: number) => void) => () => void
}

let shellKeyboard: ShellKeyboardSource | null = null

/**
 * Called once by the page entry. Inside the shell the keyboard covers the page as it covers a
 * native screen, but the WebView's IME insets are zeroed, so `visualViewport` never moves: the
 * shell is the only thing that knows the height, and every reader below answers from it.
 */
export function publishShellKeyboardSource(source: ShellKeyboardSource | null): void {
  shellKeyboard = source
}

/**
 * Outside the shell: the keyboard's height as the browser reports it, which is not as an event.
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
 * No `visualViewport` at all is 0 rather than a guess — that guard is in the two readers below,
 * which are the only things that can act on it.
 */
function occlusion(viewport: VisualViewport): number {
  if ((viewport.scale ?? 1) !== 1) {
    return 0
  }
  return Math.max(0, window.innerHeight - (viewport.height + viewport.offsetTop))
}

/** Both shapes: `null` is what the DOM declares, `undefined` is a WebView without the property. */
function visualViewport(): VisualViewport | undefined {
  return window.visualViewport ?? undefined
}

/**
 * The strip as events, with duration 0: the shell and the browser have both moved the keyboard by
 * the time they say so.
 */
export function subscribeSoftKeyboard(
  onShow: (height: number, duration: number) => void,
  onHide: (duration: number) => void
): () => void {
  let open = currentSoftKeyboardHeight() > 0
  const read = (height: number): void => {
    if (height > 0) {
      open = true
      onShow(height, 0)
    } else if (open) {
      open = false
      onHide(0)
    }
  }
  if (shellKeyboard !== null) {
    return shellKeyboard.subscribe(read)
  }
  const viewport = visualViewport()
  if (viewport === undefined) {
    return () => {}
  }
  const measure = (): void => read(occlusion(viewport))
  viewport.addEventListener('resize', measure)
  viewport.addEventListener('scroll', measure)

  return () => {
    viewport.removeEventListener('resize', measure)
    viewport.removeEventListener('scroll', measure)
  }
}

/** A keyboard already up when a composer opens gets no event at all. */
export function currentSoftKeyboardHeight(): number {
  if (shellKeyboard !== null) {
    return shellKeyboard.read()
  }
  const viewport = visualViewport()
  return viewport === undefined ? 0 : occlusion(viewport)
}

export function useKeyboardOcclusion(): number {
  const [keyboardLift, setKeyboardLift] = useState(0)

  useEffect(() => {
    setKeyboardLift(currentSoftKeyboardHeight())
    return subscribeSoftKeyboard(
      (height) => setKeyboardLift(height),
      () => setKeyboardLift(0)
    )
  }, [])

  return keyboardLift
}

/** The sibling's shape. Open is a covered strip here: neither source reports a keyboard of 0. */
export type SoftKeyboardState = { readonly height: number; readonly visible: boolean }

export function useSoftKeyboard(): SoftKeyboardState {
  const height = useKeyboardOcclusion()
  return { height, visible: height > 0 }
}
