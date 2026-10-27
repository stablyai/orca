import { useMemo, useRef, useState } from 'react'
import { Gesture } from 'react-native-gesture-handler'
import type { ComposedGesture } from 'react-native-gesture-handler'
import { quantizeFontScale } from './native-chat/transcript/mobile-native-chat-message-text'

// Anchor each pinch on the committed scale so successive gestures compound.
export function useMobileNativeChatPinchGesture(): {
  fontScale: number
  pinchGesture: ComposedGesture
} {
  const [fontScale, setFontScale] = useState(1)
  const fontScaleRef = useRef(1)
  fontScaleRef.current = fontScale
  const pinchBase = useRef(1)
  // Run callbacks on JS to access React state safely; simultaneous native scrolling keeps active lists from stealing pinch recognition.
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
            setFontScale(quantizeFontScale(pinchBase.current * e.scale))
          })
      ),
    []
  )

  return { fontScale, pinchGesture }
}
