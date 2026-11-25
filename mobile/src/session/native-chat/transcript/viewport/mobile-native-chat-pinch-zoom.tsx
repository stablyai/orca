import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import type { LegacyComposedGesture } from 'react-native-gesture-handler'
import {
  clampNativeChatTextSize,
  nativeChatFontScale,
  updateNativeChatTextSettings,
  useNativeChatTextSettingsFollowingShell
} from '../../preferences/native-chat-text-settings'

// A pinch steps the saved text size in whole points, previews here, and saves once on release for every chat.
// Each step remeasures the whole list, so frame-level scales would repaint recycled iOS paragraphs with stale clipped content.
export function useMobileNativeChatPinchGesture(): {
  fontScale: number
  pinchGesture: LegacyComposedGesture
} {
  const { size } = useNativeChatTextSettingsFollowingShell()
  const [pinched, setPinched] = useState<number | null>(null)
  const saved = useRef(size)
  useEffect(() => {
    saved.current = size
  }, [size])
  const live = useRef<number | null>(null)
  const pinchBase = useRef(size)
  // Run callbacks on JS to access React state safely; simultaneous native scrolling keeps active lists from stealing pinch recognition.
  const pinchGesture = useMemo(
    () =>
      Gesture.Simultaneous(
        Gesture.Native(),
        Gesture.Pinch()
          .runOnJS(true)
          .onStart(() => {
            pinchBase.current = live.current ?? saved.current
          })
          .onUpdate((e) => {
            live.current = clampNativeChatTextSize(pinchBase.current * e.scale)
            setPinched(live.current)
          })
          .onFinalize(() => {
            const next = live.current
            live.current = null
            if (next !== null && next !== saved.current) {
              void updateNativeChatTextSettings({ size: next })
            }
            setPinched(null)
          })
      ),
    []
  )

  return { fontScale: nativeChatFontScale(pinched ?? size), pinchGesture }
}

// Web: gesture handler 3 defaults to touch-action: none (froze touch scrolling); auto would let a pinch zoom the page instead of the text.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: valid CSS that the handler copies verbatim to style.touchAction; its union lists single keywords only.
const PAN_WITHOUT_PAGE_ZOOM = 'pan-x pan-y' as ComponentProps<typeof GestureDetector>['touchAction']

// Web: gesture handler 3 also cancels contextmenu by default, which drops Android WebView's Copy menu for selected text.
export function MobileNativeChatPinchZoom({
  gesture,
  children
}: {
  gesture: LegacyComposedGesture
  children: ReactNode
}) {
  return (
    <GestureDetector gesture={gesture} touchAction={PAN_WITHOUT_PAGE_ZOOM} enableContextMenu>
      {children}
    </GestureDetector>
  )
}
