import { useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import type { LegacyComposedGesture } from 'react-native-gesture-handler'
import { quantizeFontScale } from './mobile-native-chat-message-text'

// Anchor each pinch on the committed scale so successive gestures compound.
// The overlay reuses one view across a worktree's chats, so the scale belongs to `scopeKey`'s chat.
export function useMobileNativeChatPinchGesture(scopeKey: string): {
  fontScale: number
  pinchGesture: LegacyComposedGesture
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

// Web: gesture handler 3 defaults to touch-action: none (froze touch scrolling); auto would let a pinch zoom the page instead of the text.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: valid CSS that the handler copies verbatim to style.touchAction; its union lists single keywords only.
const PAN_WITHOUT_PAGE_ZOOM = 'pan-x pan-y' as ComponentProps<typeof GestureDetector>['touchAction']

export function MobileNativeChatPinchZoom({
  gesture,
  children
}: {
  gesture: LegacyComposedGesture
  children: ReactNode
}) {
  return (
    <GestureDetector gesture={gesture} touchAction={PAN_WITHOUT_PAGE_ZOOM}>
      {children}
    </GestureDetector>
  )
}
