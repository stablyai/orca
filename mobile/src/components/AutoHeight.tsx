import { useEffect, useRef, useState, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue
} from 'react-native-reanimated'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { BOTTOM_DRAWER_EASING, BOTTOM_DRAWER_HEIGHT_DURATION_MS } from './bottom-drawer-constants'

const HEIGHT_TIMING = { duration: BOTTOM_DRAWER_HEIGHT_DURATION_MS, easing: BOTTOM_DRAWER_EASING }

type AutoHeightProps = {
  children: ReactNode
  /** Caps the content box, so a ScrollView inside still scrolls once it is reached. */
  maxHeight?: number
  /**
   * Disclosure content: false shrinks to nothing with the content still drawn, and unmounts it
   * once closed, so a collapse never shows an empty box closing.
   */
  open?: boolean
}

/**
 * Eases its height to whatever its content measures, so a sheet that gains or loses rows grows
 * and shrinks instead of jumping. The first measurement lands without motion.
 */
export function AutoHeight({ children, maxHeight, open = true }: AutoHeightProps) {
  const reducedMotion = useReducedMotionEnabled()
  const [measured, setMeasured] = useState(false)
  const [contentMounted, setContentMounted] = useState(open)
  if (open && !contentMounted) {
    setContentMounted(true)
  }
  const height = useSharedValue(0)
  const contentHeight = useRef(0)
  // The page bundle has no worklet plugin, so web mappers read only the dependency list.
  const frameStyle = useAnimatedStyle(
    () => (measured ? { height: height.value } : {}),
    [height, measured]
  )

  useEffect(() => {
    if (!measured) {
      return
    }
    // A reopen mid-collapse gets no new layout, so head back to the content's last height.
    easeHeight(height, open ? contentHeight.current : 0, reducedMotion, () => {
      if (!open) {
        setContentMounted(false)
      }
    })
  }, [height, measured, open, reducedMotion])

  return (
    <Animated.View style={[styles.frame, frameStyle]}>
      <View
        style={[
          measured ? styles.contentMeasured : null,
          maxHeight === undefined ? null : { maxHeight }
        ]}
        onLayout={(event) => {
          const next = event.nativeEvent.layout.height
          contentHeight.current = next
          if (!measured) {
            height.value = open ? next : 0
            setMeasured(true)
            return
          }
          if (open) {
            easeHeight(height, next, reducedMotion)
          }
        }}
      >
        {contentMounted ? children : null}
      </View>
    </Animated.View>
  )
}

function easeHeight(
  height: SharedValue<number>,
  next: number,
  reducedMotion: boolean | null,
  onDone?: () => void
): void {
  if (reducedMotion === true) {
    height.value = next
    onDone?.()
    return
  }
  height.value = withTiming(next, HEIGHT_TIMING, (finished) => {
    if (finished && onDone) {
      runOnJS(onDone)()
    }
  })
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden' },
  // Out of flow once measured, so it keeps its natural height while the frame animates around it.
  contentMeasured: { position: 'absolute', top: 0, left: 0, right: 0 }
})
