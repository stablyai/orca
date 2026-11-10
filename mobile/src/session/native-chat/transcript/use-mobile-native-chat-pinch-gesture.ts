import { useMemo, useRef, useState } from 'react'
import { Gesture } from 'react-native-gesture-handler'
import type { ComposedGesture } from 'react-native-gesture-handler'
import { quantizeFontScale } from './mobile-native-chat-message-text'

// Anchor each pinch on the committed scale so successive gestures compound.
// The overlay reuses one view across a worktree's chats, so the scale belongs to `scopeKey`'s chat.
export function useMobileNativeChatPinchGesture(scopeKey: string): {
  fontScale: number
  pinchGesture: ComposedGesture
} {
  const [scaled, setScaled] = useState({ scopeKey, fontScale: 1 })
  const fontScale = scaled.scopeKey === scopeKey ? scaled.fontScale : 1
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
            const fontScale = quantizeFontScale(pinchBase.current * e.scale)
            // Same object for an unchanged step, so gesture noise commits nothing.
            setScaled((previous) =>
              previous.scopeKey === scopeKey && previous.fontScale === fontScale
                ? previous
                : { scopeKey, fontScale }
            )
          })
      ),
    [scopeKey]
  )

  return { fontScale, pinchGesture }
}
