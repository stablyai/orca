import { useEffect, useRef } from 'react'
import { Animated, Easing, Platform } from 'react-native'

/** The working ring's rotation: one turn per second while `active`, reset to 0 otherwise. */
export function useWorkingRingRotation(active: boolean): Animated.AnimatedInterpolation<string> {
  const spinValue = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (active) {
      const animation = Animated.loop(
        Animated.timing(spinValue, {
          toValue: 1,
          duration: 1000,
          easing: Easing.linear,
          // Why: web has no native driver, so a loop over a native-driver timing plays it once.
          useNativeDriver: Platform.OS !== 'web'
        })
      )
      animation.start()
      return () => animation.stop()
    }
    spinValue.setValue(0)
    return undefined
  }, [active, spinValue])

  return spinValue.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })
}
