import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Gesture } from 'react-native-gesture-handler'
import type { ComposedGesture } from 'react-native-gesture-handler'
import { quantizeFontScale } from './mobile-native-chat-message-text'
import {
  commitNativeChatTextScale,
  hydrateNativeChatTextScale,
  readInitialNativeChatTextScale,
  subscribeNativeChatTextScale
} from './mobile-native-chat-text-scale'
import { attachWebChatPinch } from './mobile-native-chat-web-pinch'

// Anchor each pinch on the committed scale so successive gestures compound.
export function useMobileNativeChatPinchGesture(): {
  fontScale: number
  /** False until a stored size is known, so the first paint is not the default scale. */
  scaleReady: boolean
  pinchGesture: ComposedGesture
  /** The transcript's element in the web page, which takes the pinch there; unused natively. */
  pinchTarget: (node: unknown) => void
} {
  // Read the published page cache here: effects run after the first paint.
  const initial = useState(readInitialNativeChatTextScale)[0]
  const [fontScale, setFontScale] = useState(initial.scale)
  const [scaleReady, setScaleReady] = useState(initial.ready)
  const fontScaleRef = useRef(fontScale)
  fontScaleRef.current = fontScale
  const pinchBase = useRef(fontScale)
  useLayoutEffect(() => {
    return subscribeNativeChatTextScale((scale) => {
      setScaleReady(true)
      if (scale === fontScaleRef.current) {
        return
      }
      fontScaleRef.current = scale
      setFontScale(scale)
    })
  }, [])
  useLayoutEffect(() => {
    let stale = false
    void hydrateNativeChatTextScale().then((scale) => {
      if (stale) {
        return
      }
      if (scale !== fontScaleRef.current) {
        fontScaleRef.current = scale
        setFontScale(scale)
      }
      setScaleReady(true)
    })
    return () => {
      stale = true
    }
  }, [])
  const applyPinch = useCallback((ratio: number) => {
    const next = quantizeFontScale(pinchBase.current * ratio)
    if (next === fontScaleRef.current) {
      return
    }
    fontScaleRef.current = next
    commitNativeChatTextScale(next)
    setFontScale(next)
  }, [])
  const detachWebPinch = useRef<(() => void) | null>(null)
  const pinchTarget = useCallback(
    (node: unknown) => {
      detachWebPinch.current?.()
      detachWebPinch.current =
        typeof HTMLElement !== 'undefined' && node instanceof HTMLElement
          ? attachWebChatPinch(node, {
              begin: () => {
                pinchBase.current = fontScaleRef.current
              },
              change: applyPinch
            })
          : null
    },
    [applyPinch]
  )
  // Run callbacks on JS so the scale can update React state. Native scroll stays in the same gesture so the list does not take the pinch.
  const pinchGesture = useMemo(
    () =>
      Gesture.Simultaneous(
        Gesture.Native(),
        Gesture.Pinch()
          .runOnJS(true)
          .onStart(() => {
            pinchBase.current = fontScaleRef.current
          })
          .onUpdate((event) => applyPinch(event.scale))
      ),
    [applyPinch]
  )

  return { fontScale, scaleReady, pinchGesture, pinchTarget }
}
