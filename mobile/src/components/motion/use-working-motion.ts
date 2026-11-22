import { useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Easing, type LayoutChangeEvent } from 'react-native'

// The page runs these as compositor animations instead (use-working-motion.web.ts).
export type WorkingMotion<Style> = { ref: (node: unknown) => void; style: Style | undefined }

function noRef(): void {}

export function useWorkingRingRotation(
  active: boolean
): WorkingMotion<{ transform: { rotate: Animated.AnimatedInterpolation<string> }[] }> {
  const spin = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (!active) {
      spin.setValue(0)
      return undefined
    }
    const animation = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 1000,
        easing: Easing.linear,
        // Decorative loops must not hold up interaction-scheduled list rendering.
        isInteraction: false,
        useNativeDriver: true
      })
    )
    animation.start()
    return () => animation.stop()
  }, [active, spin])
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })
  return { ref: noRef, style: { transform: [{ rotate }] } }
}

/** Live-work text breathing between full and half opacity on desktop's animate-pulse curve. */
export function useWorkingPulse(active: boolean): WorkingMotion<{ opacity: Animated.Value }> {
  const opacity = useRef(new Animated.Value(1)).current
  useEffect(() => {
    if (!active) {
      opacity.setValue(1)
      return undefined
    }
    const to = (toValue: number) =>
      Animated.timing(opacity, {
        toValue,
        duration: 1000,
        easing: Easing.bezier(0.4, 0, 0.6, 1),
        isInteraction: false,
        useNativeDriver: true
      })
    const animation = Animated.loop(Animated.sequence([to(0.5), to(1)]))
    animation.start()
    return () => animation.stop()
  }, [active, opacity])
  return { ref: noRef, style: { opacity } }
}

// In segment widths, like the page's percent keyframes; ends past the track's right edge.
const SWEEP_END = 3.6

/** A busy line's segment sweeping across its track; transforms can't animate percents natively, so it measures itself. */
export function useWorkingSweep(active: boolean): WorkingMotion<{
  opacity: number
  transform: { translateX: Animated.AnimatedInterpolation<number> }[]
}> & { onLayout: ((event: LayoutChangeEvent) => void) | undefined } {
  const progress = useRef(new Animated.Value(0)).current
  const [segmentWidth, setSegmentWidth] = useState(0)
  useEffect(() => {
    if (!active) {
      progress.setValue(0)
      return undefined
    }
    const animation = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 1400,
        easing: Easing.bezier(0.45, 0, 0.55, 1),
        isInteraction: false,
        useNativeDriver: true
      })
    )
    animation.start()
    return () => animation.stop()
  }, [active, progress])
  // A new node per render would re-attach to the native loop each time.
  const translateX = useMemo(
    () =>
      progress.interpolate({
        inputRange: [0, 1],
        outputRange: [-segmentWidth, segmentWidth * SWEEP_END]
      }),
    [progress, segmentWidth]
  )
  return {
    ref: noRef,
    // Unmeasured, it would sit still at the left edge for a frame.
    style: { opacity: segmentWidth === 0 ? 0 : 1, transform: [{ translateX }] },
    onLayout: (event) => setSegmentWidth(event.nativeEvent.layout.width)
  }
}
