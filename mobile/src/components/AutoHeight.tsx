import { useState, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { BOTTOM_DRAWER_EASING, BOTTOM_DRAWER_HEIGHT_DURATION_MS } from './bottom-drawer-constants'

type AutoHeightProps = {
  children: ReactNode
  /** Caps the content box, so a ScrollView inside still scrolls once it is reached. */
  maxHeight?: number
}

/**
 * Eases its height to whatever its content measures, so a sheet that gains or loses rows grows
 * and shrinks instead of jumping. The first measurement lands without motion.
 */
export function AutoHeight({ children, maxHeight }: AutoHeightProps) {
  const reducedMotion = useReducedMotionEnabled()
  const [measured, setMeasured] = useState(false)
  const height = useSharedValue(0)
  // The page bundle has no worklet plugin, so web mappers read only the dependency list.
  const frameStyle = useAnimatedStyle(
    () => (measured ? { height: height.value } : {}),
    [height, measured]
  )
  return (
    <Animated.View style={[styles.frame, frameStyle]}>
      <View
        style={[
          measured ? styles.contentMeasured : null,
          maxHeight === undefined ? null : { maxHeight }
        ]}
        onLayout={(event) => {
          const next = event.nativeEvent.layout.height
          if (!measured) {
            height.value = next
            setMeasured(true)
            return
          }
          height.value =
            reducedMotion === true
              ? next
              : withTiming(next, {
                  duration: BOTTOM_DRAWER_HEIGHT_DURATION_MS,
                  easing: BOTTOM_DRAWER_EASING
                })
        }}
      >
        {children}
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden' },
  // Out of flow once measured, so it keeps its natural height while the frame animates around it.
  contentMeasured: { position: 'absolute', top: 0, left: 0, right: 0 }
})
