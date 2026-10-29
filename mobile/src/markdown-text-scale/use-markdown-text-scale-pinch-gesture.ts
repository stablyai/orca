import { useMemo, useRef } from 'react'
import { Platform } from 'react-native'
import { Gesture } from 'react-native-gesture-handler'
import { quantizeLiveMarkdownTextScale, snapMarkdownTextScale } from './markdown-text-scales'

// Pinch anchored on the current scale; mirrors useMobileNativeChatPinchGesture.
export function useMarkdownTextScalePinchGesture({
  textScale,
  onLiveScale,
  onCommit,
  combineWithNativeScroll
}: {
  textScale: number
  onLiveScale: (scale: number) => void
  onCommit: (scale: number) => void
  combineWithNativeScroll: boolean
}) {
  const scaleRef = useRef(textScale)
  scaleRef.current = textScale
  const pinchBase = useRef(scaleRef.current)
  const pinching = useRef(false)

  return useMemo(() => {
    // JS-thread callbacks: they touch React state, which a UI-thread worklet cannot.
    const pinch = Gesture.Pinch()
      .runOnJS(true)
      .onStart(() => {
        pinching.current = true
        pinchBase.current = scaleRef.current
      })
      .onUpdate((e) => {
        const next = quantizeLiveMarkdownTextScale(pinchBase.current * e.scale)
        if (next !== scaleRef.current) {
          scaleRef.current = next
          onLiveScale(next)
        }
      })
      // Finalize also fires for a cancelled pinch, which never reaches a successful end.
      .onFinalize(() => {
        if (pinching.current) {
          pinching.current = false
          onCommit(snapMarkdownTextScale(scaleRef.current))
        }
      })
    // Native() keeps native ScrollViews scrolling; on web it overwrites touch-action, and the editor wrapper isn't a scroller.
    return combineWithNativeScroll && Platform.OS !== 'web'
      ? Gesture.Simultaneous(Gesture.Native(), pinch)
      : pinch
  }, [onLiveScale, onCommit, combineWithNativeScroll])
}
