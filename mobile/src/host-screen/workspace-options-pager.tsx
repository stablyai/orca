import { useCallback, useState, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue
} from 'react-native-reanimated'
import {
  PUSH_CURVE,
  PUSH_SLIDE_MS,
  PUSH_UNDER_DIM,
  PUSH_UNDER_SHIFT
} from '../navigation/push-motion'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

// Built per call: a module-level easing would run before a test's Reanimated mock can serve it.
function slideTiming(duration: number) {
  return { duration, easing: Easing.bezier(...PUSH_CURVE) }
}

export function useOptionPager<Key extends string>() {
  const reduceMotion = useReducedMotionEnabled()
  const duration = reduceMotion ? 0 : PUSH_SLIDE_MS
  const [page, setPage] = useState<Key | null>(null)
  // 0 shows the page; 1 parks it one width to the right.
  const slide = useSharedValue(1)

  const open = useCallback(
    (key: Key) => {
      slide.value = 1
      setPage(key)
      slide.value = withTiming(0, slideTiming(duration))
    },
    [duration, slide]
  )
  const close = useCallback(() => {
    if (duration === 0) {
      setPage(null)
      return
    }
    slide.value = withTiming(1, slideTiming(duration), (finished) => {
      if (finished) {
        runOnJS(setPage)(null)
      }
    })
  }, [duration, slide])

  const forget = useCallback(() => setPage(null), [])

  return { page, open, close, forget, slide }
}

export type OptionPagerControls<Key extends string> = ReturnType<typeof useOptionPager<Key>>

// Keep the main sheet laid out under its page so opening or closing it cannot change drawer height.
export function OptionPager(props: {
  pager: { slide: SharedValue<number> }
  main: ReactNode
  page: ReactNode | null
}) {
  useMobileColorScheme()
  const [width, setWidth] = useState(0)
  const [mainHeight, setMainHeight] = useState<number | null>(null)
  const { slide } = props.pager
  // Web has no worklet plugin; mapper hooks need this explicit dependency list.
  const pageStyle = useAnimatedStyle(
    () => ({ transform: [{ translateX: slide.value * width }] }),
    [slide, width]
  )
  // The main list drifts left and dims under the page, like the screen under an iOS push.
  const mainStyle = useAnimatedStyle(
    () => ({ transform: [{ translateX: -(1 - slide.value) * PUSH_UNDER_SHIFT * width }] }),
    [slide, width]
  )
  const dimStyle = useAnimatedStyle(
    () => ({ opacity: (1 - slide.value) * PUSH_UNDER_DIM }),
    [slide]
  )
  const pageOpen = props.page !== null
  return (
    <View
      style={[styles.pager, pageOpen && mainHeight !== null && { minHeight: mainHeight }]}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <Animated.View
        style={[pageOpen && styles.underlay, mainStyle]}
        // Measured while under a page too, so a change behind the page does not jump on the way out.
        onLayout={(event) => setMainHeight(event.nativeEvent.layout.height)}
        pointerEvents={pageOpen ? 'none' : 'auto'}
        aria-hidden={pageOpen}
      >
        {props.main}
        {pageOpen && <Animated.View pointerEvents="none" style={[styles.dim, dimStyle]} />}
      </Animated.View>
      {pageOpen && <Animated.View style={[styles.page, pageStyle]}>{props.page}</Animated.View>}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  pager: { overflow: 'hidden' },
  underlay: { position: 'absolute', top: 0, left: 0, right: 0 },
  page: { flexGrow: 1, backgroundColor: colors.sheetSurface },
  dim: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' }
}))
