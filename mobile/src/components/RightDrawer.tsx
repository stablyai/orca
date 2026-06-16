import { type ReactNode, useCallback, useEffect, useState } from 'react'
import {
  View,
  Pressable,
  StyleSheet,
  Platform,
  useWindowDimensions,
  Keyboard,
  BackHandler
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useAnimatedScrollHandler,
  withSpring,
  withTiming,
  runOnJS,
  interpolate,
  Extrapolation
} from 'react-native-reanimated'
import { colors, spacing } from '../theme/mobile-theme'
// Why: mount-before-commit logic is anchor-agnostic, so the X-axis drawer reuses
// the exact same gate as BottomDrawer rather than duplicating it.
import { resolveBottomDrawerMounted } from './bottom-drawer-mount-state'
import { resolveRightDrawerPanelWidth } from './right-drawer-panel-width'
import { useResponsiveLayout } from '../layout/responsive-layout'

const DISMISS_THRESHOLD = 80
const SPRING_CONFIG = { damping: 28, stiffness: 400 }
// Why: leftward drags (negative translateX) pull the panel past its docked edge;
// damp them with a rubber-band factor so the drawer resists over-pulling inward.
const RUBBER_BAND_FACTOR = 0.25
const SHOW_DURATION = 180
const HIDE_DURATION = 150

type Props = {
  visible: boolean
  onClose: () => void
  children: ReactNode
  zIndex?: number
  widthPx?: number
}

export function RightDrawer({ visible, onClose, children, zIndex, widthPx }: Props) {
  const [mounted, setMounted] = useState(visible)
  const resolvedMounted = resolveBottomDrawerMounted(visible, mounted)

  // Why: opening drawers should mount before commit; waiting for a passive
  // Effect adds a null render before the drawer can animate in.
  if (resolvedMounted !== mounted) {
    setMounted(resolvedMounted)
  }

  // Why: hidden drawers are rendered by parent screens even while closed; keep
  // their Reanimated/Gesture setup out of hot paths until they are actually shown.
  if (!resolvedMounted) {
    return null
  }

  return (
    <MountedRightDrawer
      visible={visible}
      onClose={onClose}
      onHidden={() => setMounted(false)}
      zIndex={zIndex}
      widthPx={widthPx}
    >
      {children}
    </MountedRightDrawer>
  )
}

type MountedRightDrawerProps = Props & {
  onHidden: () => void
}

function MountedRightDrawer({
  visible,
  onClose,
  onHidden,
  children,
  zIndex = 1000,
  widthPx
}: MountedRightDrawerProps) {
  const translateX = useSharedValue(0)
  const progress = useSharedValue(0)
  const scrollOffsetY = useSharedValue(0)
  const { width: screenWidth } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const { isWideLayout } = useResponsiveLayout()
  const panelWidth = resolveRightDrawerPanelWidth(screenWidth, isWideLayout, widthPx)

  useEffect(() => {
    if (visible) {
      translateX.value = 0
      scrollOffsetY.value = 0
      progress.value = withTiming(1, { duration: SHOW_DURATION })
    } else {
      Keyboard.dismiss()
      progress.value = withTiming(0, { duration: HIDE_DURATION }, (finished) => {
        if (finished) {
          runOnJS(onHidden)()
        }
      })
    }
  }, [onHidden, visible])

  // Why: KeyboardAvoidingView and useAnimatedKeyboard are both unreliable inside
  // overlay-style views; dismiss the keyboard when the drawer closes so a focused
  // input inside it doesn't linger over the diff. The right-anchored panel is
  // full-height, so the keyboard needs no X translation — only this cleanup.
  useEffect(() => {
    if (!visible) {
      return
    }
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
    const onHide = Keyboard.addListener(hideEvent, () => {})
    return () => onHide.remove()
  }, [visible])

  useEffect(() => {
    if (!visible) {
      return
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose()
      return true
    })
    return () => sub.remove()
  }, [visible, onClose])

  const dismiss = useCallback(() => {
    onClose()
  }, [onClose])

  const scrollHandler = useAnimatedScrollHandler((event) => {
    scrollOffsetY.value = Math.max(event.contentOffset.y, 0)
  })

  const scrollGesture = Gesture.Native()
  // Why: swipe-from-right (positive translationX) dismisses; the horizontal
  // activeOffset lets the inner vertical ScrollView keep its gestures.
  const panGesture = Gesture.Pan()
    .activeOffsetX([-8, 8])
    .simultaneousWithExternalGesture(scrollGesture)
    .onUpdate((e) => {
      if (e.translationX > 0) {
        translateX.value = e.translationX
      } else {
        translateX.value = e.translationX * RUBBER_BAND_FACTOR
      }
    })
    .onEnd((e) => {
      if (e.translationX > DISMISS_THRESHOLD || e.velocityX > 500) {
        const velocity = Math.max(e.velocityX, 800)
        const remaining = panelWidth - e.translationX
        const duration = Math.min(Math.max((remaining / velocity) * 1000, 120), 300)
        translateX.value = withTiming(panelWidth, { duration })
        progress.value = withTiming(0, { duration }, () => {
          runOnJS(dismiss)()
        })
      } else {
        translateX.value = withSpring(0, SPRING_CONFIG)
      }
    })

  const drawerStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX:
          interpolate(progress.value, [0, 1], [panelWidth, 0], Extrapolation.CLAMP) +
          translateX.value
      }
    ]
  }))

  const backdropStyle = useAnimatedStyle(() => {
    const dragFade = interpolate(translateX.value, [0, panelWidth], [1, 0], Extrapolation.CLAMP)
    return { opacity: progress.value * dragFade }
  })

  return (
    <Animated.View
      pointerEvents={visible ? 'auto' : 'none'}
      style={[styles.overlay, { zIndex, elevation: zIndex }]}
      accessibilityViewIsModal
      aria-modal
    >
      <GestureHandlerRootView style={styles.root}>
        <Animated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} />
        </Animated.View>

        <View style={styles.anchor} pointerEvents="box-none">
          <GestureDetector gesture={panGesture}>
            <Animated.View
              style={[
                styles.drawer,
                {
                  width: panelWidth,
                  paddingTop: insets.top + spacing.md,
                  paddingBottom: insets.bottom + spacing.lg,
                  paddingRight: insets.right
                },
                drawerStyle
              ]}
            >
              <GestureDetector gesture={scrollGesture}>
                <Animated.ScrollView
                  bounces={false}
                  keyboardShouldPersistTaps="handled"
                  onScroll={scrollHandler}
                  scrollEventThrottle={16}
                  showsVerticalScrollIndicator={false}
                >
                  {children}
                </Animated.ScrollView>
              </GestureDetector>
            </Animated.View>
          </GestureDetector>
        </View>
      </GestureHandlerRootView>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1000
  },
  root: {
    flex: 1
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)'
  },
  anchor: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'flex-end'
  },
  drawer: {
    height: '100%',
    backgroundColor: colors.bgBase,
    borderTopLeftRadius: 16,
    borderBottomLeftRadius: 16,
    paddingHorizontal: spacing.md,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.borderSubtle,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: -2, height: 0 },
        shadowOpacity: 0.2,
        shadowRadius: 10
      },
      android: { elevation: 8 }
    })
  }
})
