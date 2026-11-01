import { useCallback, useState, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, {
  Easing,
  ReduceMotion,
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
import { useDrawerReducedMotion } from './bottom-drawer-constants'
import { REDUCED_MOTION_FADE_MS } from './sheet-motion-values'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { KeyedBottomDrawer } from './keyed-bottom-drawer'

type Props = {
  visible: boolean
  onClose: () => void
  onAfterClose?: () => void
  children: ReactNode
  dragContentToDismiss?: boolean
  contentScrollable?: boolean
  // Stable outer frame keeps docked input above keyboard while results reflow; content-sized sheets move it on every list change.
  fillAvailable?: boolean
  // Pin outer sheet under fill picker without extra touches, backdrop or keyboard lift.
  interactive?: boolean
  zIndex?: number
  scrollResetKey?: string | null
}

const SHOWN = 'shown'
const sheetKey = () => SHOWN

export function BottomDrawer({ visible, onClose, onAfterClose, children, ...drawerProps }: Props) {
  // Closed drawers render nothing to avoid Reanimated/Gesture setup in hot paths even when parent mounts them.
  return (
    <KeyedBottomDrawer
      {...drawerProps}
      sheet={visible ? SHOWN : null}
      sheetKey={sheetKey}
      onClose={onClose}
      onAfterClose={onAfterClose}
    >
      {() => children}
    </KeyedBottomDrawer>
  )
}

// The push between a drawer's (or a screen's) pages lives beside BottomDrawer: as its own module it costs the page bundle a shared chunk under the asset ceiling.
// Built per call: a module-level easing would run before a test's Reanimated mock can serve it.
function pageTiming(reducedMotion: boolean) {
  // Under Reduce Motion the page cross-fades instead of sliding, and that fade must still run.
  return reducedMotion
    ? { duration: REDUCED_MOTION_FADE_MS, reduceMotion: ReduceMotion.Never }
    : { duration: PUSH_SLIDE_MS, easing: Easing.bezier(...PUSH_CURVE) }
}

export function useOptionPager<Key extends string>() {
  const reducedMotion = useDrawerReducedMotion()
  const [page, setPage] = useState<Key | null>(null)
  // 0 shows the page; 1 parks it one width to the right.
  const slide = useSharedValue(1)

  const open = useCallback(
    (key: Key) => {
      slide.value = 1
      setPage(key)
      slide.value = withTiming(0, pageTiming(reducedMotion))
    },
    [reducedMotion, slide]
  )
  const close = useCallback(() => {
    slide.value = withTiming(1, pageTiming(reducedMotion), (finished) => {
      if (finished) {
        runOnJS(setPage)(null)
      }
    })
  }, [reducedMotion, slide])

  const forget = useCallback(() => setPage(null), [])

  return { page, open, close, forget, slide, reducedMotion }
}

export type OptionPagerControls<Key extends string> = ReturnType<typeof useOptionPager<Key>>

// Keep the main sheet laid out under its page so opening or closing it cannot change drawer height.
export function OptionPager(props: {
  pager: { slide: SharedValue<number>; reducedMotion: boolean }
  main: ReactNode
  page: ReactNode | null
  /** Fills a screen instead of sizing a sheet: the page covers the main view on the screen background. */
  fill?: boolean
}) {
  useMobileColorScheme()
  const [width, setWidth] = useState(0)
  const [mainHeight, setMainHeight] = useState<number | null>(null)
  const { slide, reducedMotion } = props.pager
  // Web has no worklet plugin; mapper hooks need this explicit dependency list.
  const pageStyle = useAnimatedStyle(
    () =>
      reducedMotion
        ? { opacity: 1 - slide.value, transform: [{ translateX: 0 }] }
        : { opacity: 1, transform: [{ translateX: slide.value * width }] },
    [slide, width, reducedMotion]
  )
  // The main list drifts left and dims under the page, like the screen under an iOS push.
  const under = reducedMotion ? 0 : 1
  const mainStyle = useAnimatedStyle(
    () => ({
      transform: [{ translateX: -(1 - slide.value) * PUSH_UNDER_SHIFT * width * under }]
    }),
    [slide, width, under]
  )
  const dimStyle = useAnimatedStyle(
    () => ({ opacity: (1 - slide.value) * PUSH_UNDER_DIM * under }),
    [slide, under]
  )
  const pageOpen = props.page !== null
  if (props.fill) {
    return (
      <View style={styles.fill} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
        <Animated.View
          style={[styles.fill, mainStyle]}
          pointerEvents={pageOpen ? 'none' : 'auto'}
          aria-hidden={pageOpen}
        >
          {props.main}
          {pageOpen && <Animated.View pointerEvents="none" style={[styles.dim, dimStyle]} />}
        </Animated.View>
        {pageOpen && (
          <Animated.View style={[styles.fillPage, pageStyle]}>{props.page}</Animated.View>
        )}
      </View>
    )
  }
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
  dim: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  fill: { flex: 1, overflow: 'hidden' },
  fillPage: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.bgBase }
}))
