import { useEffect, useRef, useState, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming
} from 'react-native-reanimated'
import { useReducedMotionEnabled } from '../../platform/use-reduced-motion'
import { HEIGHT_DURATION_MS, HEIGHT_EASING } from './height-motion'

type CollapsibleProps = {
  open: boolean
  children: ReactNode
  /** Keeps the body mounted while shut, for bodies that hold state such as half-filled answers. */
  keepMounted?: boolean
}

/**
 * The body of a disclosure: it eases open to its content's height and fades in, eases shut, and
 * follows its content when that grows or shrinks while open. Pair it with a chevron on
 * `slideTransition` in the row that toggles it.
 */
export function Collapsible({ open, children, keepMounted = false }: CollapsibleProps) {
  const reducedMotion = useReducedMotionEnabled()
  const [mounted, setMounted] = useState(open || keepMounted)
  // A body that starts open lays out in flow until measured, so it never draws at zero height.
  const startedOpen = useRef(open).current
  const [measured, setMeasured] = useState(false)
  const progress = useSharedValue(open ? 1 : 0)
  const contentHeight = useSharedValue(0)
  const duration = reducedMotion === true ? 0 : HEIGHT_DURATION_MS

  useEffect(() => {
    if (open) {
      setMounted(true)
    }
    progress.value = withTiming(open ? 1 : 0, { duration, easing: HEIGHT_EASING }, (finished) => {
      if (finished && !open && !keepMounted) {
        runOnJS(setMounted)(false)
      }
    })
  }, [duration, keepMounted, open, progress])

  const inFlow = startedOpen && !measured
  // Why the dependency list: the page bundle has no worklet plugin, so web mappers read only it.
  const frameStyle = useAnimatedStyle(
    () =>
      inFlow
        ? { opacity: progress.value }
        : { height: progress.value * contentHeight.value, opacity: progress.value },
    [progress, contentHeight, inFlow]
  )

  if (!mounted) {
    return null
  }
  return (
    <Animated.View
      style={[styles.frame, frameStyle]}
      pointerEvents={open ? 'auto' : 'none'}
      aria-hidden={!open}
    >
      <View
        style={inFlow ? null : styles.content}
        onLayout={(event) => {
          const next = event.nativeEvent.layout.height
          if (!measured) {
            contentHeight.value = next
            setMeasured(true)
            return
          }
          contentHeight.value = withTiming(next, { duration, easing: HEIGHT_EASING })
        }}
      >
        {children}
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden' },
  content: { position: 'absolute', top: 0, left: 0, right: 0 }
})
