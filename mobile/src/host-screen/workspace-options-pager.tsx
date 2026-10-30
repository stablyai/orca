import { useCallback, useState, type ReactNode } from 'react'
import { View } from 'react-native'
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue
} from 'react-native-reanimated'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

const PAGE_SLIDE_MS = 200

export function useOptionPager<Key extends string>() {
  const reduceMotion = useReducedMotionEnabled()
  const duration = reduceMotion ? 0 : PAGE_SLIDE_MS
  const [page, setPage] = useState<Key | null>(null)
  // 0 shows the page; 1 parks it one width to the right.
  const slide = useSharedValue(1)

  const open = useCallback(
    (key: Key) => {
      slide.value = 1
      setPage(key)
      slide.value = withTiming(0, { duration })
    },
    [duration, slide]
  )
  const close = useCallback(() => {
    if (duration === 0) {
      setPage(null)
      return
    }
    slide.value = withTiming(1, { duration }, (finished) => {
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
  const pageOpen = props.page !== null
  return (
    <View
      style={[styles.pager, pageOpen && mainHeight !== null && { minHeight: mainHeight }]}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <View
        style={pageOpen && styles.underlay}
        // Measured while under a page too, so a change behind the page does not jump on the way out.
        onLayout={(event) => setMainHeight(event.nativeEvent.layout.height)}
        pointerEvents={pageOpen ? 'none' : 'auto'}
        aria-hidden={pageOpen}
      >
        {props.main}
      </View>
      {pageOpen && <Animated.View style={[styles.page, pageStyle]}>{props.page}</Animated.View>}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  pager: { overflow: 'hidden' },
  underlay: { position: 'absolute', top: 0, left: 0, right: 0 },
  page: { flexGrow: 1, backgroundColor: colors.bgBase }
}))
