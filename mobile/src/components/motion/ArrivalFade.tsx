import { useEffect, useState, type ReactNode } from 'react'
import { Animated, Easing, Platform } from 'react-native'

const ARRIVAL_FADE_MS = 150

/**
 * Fades its content in once, on mount: a state that arrives into a slot drawn empty, such as agent
 * dots filling in when the live read lands over stored rows. Without `animate` it shows at once.
 */
export function ArrivalFade({ animate, children }: { animate: boolean; children: ReactNode }) {
  const [opacity] = useState(() => new Animated.Value(animate ? 0 : 1))
  useEffect(() => {
    if (!animate) {
      return undefined
    }
    const fade = Animated.timing(opacity, {
      toValue: 1,
      duration: ARRIVAL_FADE_MS,
      easing: Easing.out(Easing.quad),
      isInteraction: false,
      useNativeDriver: Platform.OS !== 'web'
    })
    fade.start()
    return () => fade.stop()
    // Mount only: a later change of `animate` never replays the fade.
  }, [])
  return <Animated.View style={{ opacity }}>{children}</Animated.View>
}
