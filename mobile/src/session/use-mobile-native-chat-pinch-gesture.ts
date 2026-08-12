import { useMemo, useRef, useState } from 'react'
import { Gesture } from 'react-native-gesture-handler'
import type { ComposedGesture } from 'react-native-gesture-handler'
import { clampFontScale } from './mobile-native-chat-message-text'

/** Pinch-to-zoom chat font. `fontScale` is the committed size; `pinchBase`
 *  anchors the live gesture so successive pinches compound rather than reset. */
export function useMobileNativeChatPinchGesture(): {
  fontScale: number
  pinchGesture: ComposedGesture
} {
  const [fontScale, setFontScale] = useState(1)
  const fontScaleRef = useRef(1)
  fontScaleRef.current = fontScale
  const pinchBase = useRef(1)
  // Why: run the gesture callbacks on the JS thread (not a reanimated worklet) so
  // they can touch React refs/state and clampFontScale directly — accessing those
  // from the UI-thread worklet crashes the app.
  // Compose the pinch with the list's native scroll as Simultaneous so a
  // two-finger pinch is recognized even while the scroll view is active —
  // otherwise the scroll grabs the gesture first and the pinch never fires.
  const pinchGesture = useMemo(
    () =>
      Gesture.Simultaneous(
        Gesture.Native(),
        Gesture.Pinch()
          .runOnJS(true)
          .onStart(() => {
            pinchBase.current = fontScaleRef.current
          })
          .onUpdate((e) => {
            setFontScale(clampFontScale(pinchBase.current * e.scale))
          })
      ),
    []
  )

  return { fontScale, pinchGesture }
}
