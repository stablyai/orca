import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { View, Pressable, StyleSheet, Platform, Keyboard } from 'react-native'
import { useSafeAreaFrame, useSafeAreaInsets } from 'react-native-safe-area-context'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
  interpolate,
  Extrapolation
} from 'react-native-reanimated'
import { useBackClaim } from '../navigation/use-back-claim'
import { colors, spacing } from '../theme/mobile-theme'
// Reuse BottomDrawer’s anchor-independent mount-before-commit gate.
import { resolveBottomDrawerMounted } from './bottom-drawer-mount-state'
import { resolveRightDrawerPanelWidth } from './right-drawer-panel-width'
import { useResponsiveLayout } from '../layout/responsive-layout'

const DISMISS_THRESHOLD = 80
const SPRING_CONFIG = { damping: 28, stiffness: 400 }
// Damp negative translateX so panel resists pulling inward past docked edge.
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

  // Mount opening drawer before commit; passive effect adds blank render before animation.
  if (resolvedMounted !== mounted) {
    setMounted(resolvedMounted)
  }

  // Keep Reanimated/Gesture setup out of closed-drawer parent hot paths.
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
  const { width: screenWidth } = useSafeAreaFrame()
  const insets = useSafeAreaInsets()
  const { isWideLayout } = useResponsiveLayout()
  const panelWidth = resolveRightDrawerPanelWidth(screenWidth, isWideLayout, widthPx)

  useEffect(() => {
    if (visible) {
      translateX.value = 0
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

  // Use native hardware Back or page’s shell Back claim; review route reaches both platform seams.
  useBackClaim(
    visible
      ? () => {
          onClose()
          return true
        }
      : null
  )

  const dismiss = useCallback(() => {
    onClose()
  }, [onClose])

  const scrollGesture = Gesture.Native()
  // Positive horizontal swipe dismisses; activeOffset leaves vertical ScrollView gestures intact.
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

  const drawerStyle = useAnimatedStyle(
    () => ({
      transform: [
        {
          translateX:
            interpolate(progress.value, [0, 1], [panelWidth, 0], Extrapolation.CLAMP) +
            translateX.value
        }
      ]
    }),
    [progress, translateX, panelWidth]
  )

  const backdropStyle = useAnimatedStyle(() => {
    const dragFade = interpolate(translateX.value, [0, panelWidth], [1, 0], Extrapolation.CLAMP)
    return { opacity: progress.value * dragFade }
  }, [progress, translateX, panelWidth])

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
