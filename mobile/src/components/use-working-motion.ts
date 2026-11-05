import { useEffect, useRef } from 'react'
import { Animated, Easing } from 'react-native'

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
