import { useState, type ReactNode } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { useReducedMotionEnabled } from '../../platform/use-reduced-motion'
import { HEIGHT_DURATION_MS, HEIGHT_EASING } from './height-motion'

type AutoHeightProps = {
  children: ReactNode
  /** Caps the content box, so a ScrollView inside still scrolls once it is reached. */
  maxHeight?: number
  style?: StyleProp<ViewStyle>
}

/**
 * Eases its own height to whatever its content measures, so a sheet or card that gains or loses
 * rows grows and shrinks instead of jumping. The first measurement lands without motion.
 */
export function AutoHeight({ children, maxHeight, style }: AutoHeightProps) {
  const reducedMotion = useReducedMotionEnabled()
  const [measured, setMeasured] = useState(false)
  const height = useSharedValue(0)
  // Why the dependency list: the page bundle has no worklet plugin, so web mappers read only it.
  const frameStyle = useAnimatedStyle(
    () => (measured ? { height: height.value } : {}),
    [height, measured]
  )
  return (
    <Animated.View style={[styles.frame, frameStyle, style]}>
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
              : withTiming(next, { duration: HEIGHT_DURATION_MS, easing: HEIGHT_EASING })
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
