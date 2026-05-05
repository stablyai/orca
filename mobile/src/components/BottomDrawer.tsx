import { type ReactNode, useCallback, useEffect, useState } from 'react'
import {
  View,
  Pressable,
  StyleSheet,
  Platform,
  useWindowDimensions,
  ScrollView,
  Keyboard,
  BackHandler
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
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
import { colors, spacing } from '../theme/mobile-theme'

const DISMISS_THRESHOLD = 80
const SPRING_CONFIG = { damping: 28, stiffness: 400 }
// Why: negative translateY (pulling up) is damped with a rubber-band factor
// so the drawer resists upward dragging — a subtle polish touch that signals
// the drawer cannot expand further.
const RUBBER_BAND_FACTOR = 0.25
const SHOW_DURATION = 180
const HIDE_DURATION = 150

type Props = {
  visible: boolean
  onClose: () => void
  children: ReactNode
}

export function BottomDrawer({ visible, onClose, children }: Props) {
  const [mounted, setMounted] = useState(visible)
  const translateY = useSharedValue(0)
  const progress = useSharedValue(0)
  const keyboardOffset = useSharedValue(0)
  const { height: screenHeight } = useWindowDimensions()
  const insets = useSafeAreaInsets()

  useEffect(() => {
    if (visible) {
      setMounted(true)
    }
  }, [visible])

  useEffect(() => {
    if (!mounted) return

    if (visible) {
      translateY.value = 0
      progress.value = withTiming(1, { duration: SHOW_DURATION })
    } else {
      Keyboard.dismiss()
      progress.value = withTiming(0, { duration: HIDE_DURATION }, (finished) => {
        if (finished) {
          runOnJS(setMounted)(false)
        }
      })
    }
  }, [mounted, visible])

  // Why: KeyboardAvoidingView and useAnimatedKeyboard are both unreliable
  // inside Modal (iOS ignores KAV; Android needs adjustNothing for
  // useAnimatedKeyboard). Keyboard event listeners work on both platforms
  // and give us the exact height to shift the drawer by.
  useEffect(() => {
    if (!visible) return

    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'

    const onShow = Keyboard.addListener(showEvent, (e) => {
      const height = e.endCoordinates.height - insets.bottom
      keyboardOffset.value = withTiming(Math.max(height, 0), { duration: e.duration || 250 })
    })
    const onHide = Keyboard.addListener(hideEvent, (e) => {
      keyboardOffset.value = withTiming(0, { duration: e.duration || 250 })
    })

    return () => {
      onShow.remove()
      onHide.remove()
      keyboardOffset.value = 0
    }
  }, [visible, insets.bottom])

  useEffect(() => {
    if (!visible) return

    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose()
      return true
    })
    return () => sub.remove()
  }, [visible, onClose])

  const dismiss = useCallback(() => {
    onClose()
  }, [onClose])

  const panGesture = Gesture.Pan()
    .onUpdate((e) => {
      if (e.translationY > 0) {
        translateY.value = e.translationY
      } else {
        translateY.value = e.translationY * RUBBER_BAND_FACTOR
      }
    })
    .onEnd((e) => {
      if (e.translationY > DISMISS_THRESHOLD || e.velocityY > 500) {
        const velocity = Math.max(e.velocityY, 800)
        const remaining = screenHeight - e.translationY
        const duration = Math.min(Math.max((remaining / velocity) * 1000, 120), 300)
        translateY.value = withTiming(screenHeight, { duration })
        progress.value = withTiming(0, { duration }, () => {
          runOnJS(dismiss)()
        })
      } else {
        translateY.value = withSpring(0, SPRING_CONFIG)
      }
    })

  const drawerStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateY:
          interpolate(progress.value, [0, 1], [screenHeight, 0], Extrapolation.CLAMP) +
          translateY.value -
          keyboardOffset.value
      }
    ]
  }))

  const backdropStyle = useAnimatedStyle(() => {
    const dragFade = interpolate(translateY.value, [0, 300], [1, 0], Extrapolation.CLAMP)
    return { opacity: progress.value * dragFade }
  })

  const pointerStyle = useAnimatedStyle(
    () =>
      ({
        pointerEvents: progress.value > 0 ? 'auto' : 'none'
      }) as { pointerEvents: 'auto' | 'none' }
  )

  // Why: hidden drawers can contain auto-focused inputs; keeping them mounted
  // lets Android open the keyboard even when the drawer is offscreen.
  if (!mounted) return null

  return (
    <Animated.View style={[styles.overlay, pointerStyle]} accessibilityViewIsModal aria-modal>
      <GestureHandlerRootView style={styles.root}>
        <Animated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} />
        </Animated.View>

        <View style={styles.anchor} pointerEvents="box-none">
          <Animated.View
            style={[
              styles.drawer,
              {
                maxHeight: screenHeight - insets.top - spacing.lg,
                paddingBottom: insets.bottom + spacing.lg
              },
              drawerStyle
            ]}
          >
            <GestureDetector gesture={panGesture}>
              <Animated.View
                style={styles.handleHitArea}
                accessibilityRole="button"
                accessibilityLabel="Dismiss drawer"
              >
                <View style={styles.handle} />
              </Animated.View>
            </GestureDetector>
            <ScrollView
              bounces={false}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {children}
            </ScrollView>
            <View style={styles.bottomExtension} />
          </Animated.View>
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
    justifyContent: 'flex-end'
  },
  drawer: {
    backgroundColor: colors.bgBase,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: spacing.md,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -2 },
        shadowOpacity: 0.2,
        shadowRadius: 10
      },
      android: { elevation: 8 }
    })
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.textMuted,
    opacity: 0.4
  },
  handleHitArea: {
    alignItems: 'center',
    paddingTop: spacing.sm,
    paddingBottom: spacing.md
  },
  bottomExtension: {
    position: 'absolute',
    bottom: -500,
    left: 0,
    right: 0,
    height: 500,
    backgroundColor: colors.bgBase
  }
})
