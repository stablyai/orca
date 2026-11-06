import { useEffect, useRef, type ReactNode } from 'react'
import { Animated, Easing, Platform } from 'react-native'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { SHEET_CURVE, SHEET_HEIGHT_DURATION_MS } from './sheet-motion-values'

/** Turns its chevron with the AutoHeight it discloses: same curve, same duration. */
export function DisclosureChevron({
  expanded,
  collapsedDeg,
  expandedDeg,
  children
}: {
  expanded: boolean
  collapsedDeg: number
  expandedDeg: number
  children: ReactNode
}) {
  const reducedMotion = useReducedMotionEnabled()
  const turn = useRef(new Animated.Value(expanded ? 1 : 0)).current
  useEffect(() => {
    const target = expanded ? 1 : 0
    if (reducedMotion === true) {
      turn.setValue(target)
      return
    }
    const animation = Animated.timing(turn, {
      toValue: target,
      duration: SHEET_HEIGHT_DURATION_MS,
      easing: Easing.bezier(...SHEET_CURVE),
      useNativeDriver: Platform.OS !== 'web'
    })
    animation.start()
    return () => animation.stop()
  }, [expanded, reducedMotion, turn])
  const rotate = turn.interpolate({
    inputRange: [0, 1],
    outputRange: [`${collapsedDeg}deg`, `${expandedDeg}deg`]
  })
  return <Animated.View style={{ transform: [{ rotate }] }}>{children}</Animated.View>
}
