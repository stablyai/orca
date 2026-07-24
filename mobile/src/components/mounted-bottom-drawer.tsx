import { type ReactNode, useCallback, useEffect, useState } from 'react'
import {
  View,
  Pressable,
  useWindowDimensions,
  ScrollView,
  Keyboard,
  BackHandler,
  Modal,
  Platform
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
import { spacing } from '../theme/mobile-theme'
import { resolveBottomDrawerFillHeight } from './bottom-drawer-fill-height'
import { resolveBottomDrawerKeyboardInset } from './bottom-drawer-keyboard-inset'
import { BOTTOM_DRAWER_HIDE_DURATION_MS } from './bottom-drawer-constants'
import { bottomDrawerStyles as styles } from './bottom-drawer-styles'
import { useInsideBottomDrawerModalHost } from './bottom-drawer-modal-host'
import { useResponsiveLayout } from '../layout/responsive-layout'

const DISMISS_THRESHOLD = 80
const SPRING_CONFIG = { damping: 28, stiffness: 400 }
// Why: negative translateY (pulling up) is damped with a rubber-band factor
// so the drawer resists upward dragging — a subtle polish touch that signals
// the drawer cannot expand further.
const RUBBER_BAND_FACTOR = 0.25
const SHOW_DURATION = 180
const TOP_SCROLL_EPSILON = 1

export type MountedBottomDrawerProps = {
  visible: boolean
  onClose: () => void
  onHidden: () => void
  children: ReactNode
  dragContentToDismiss?: boolean
  contentScrollable?: boolean
  fillAvailable?: boolean
  // Why: outer sheets pinned under an inner fill picker stay laid out (size
  // preserved) but must not take touches, stack backdrops, or keyboard-lift.
  interactive?: boolean
  zIndex?: number
}

export function MountedBottomDrawer({
  visible,
  onClose,
  onHidden,
  children,
  dragContentToDismiss = true,
  contentScrollable = true,
  fillAvailable = false,
  interactive = true,
  zIndex = 1000
}: MountedBottomDrawerProps) {
  const translateY = useSharedValue(0)
  const progress = useSharedValue(0)
  const keyboardOffset = useSharedValue(0)
  const scrollOffsetY = useSharedValue(0)
  const contentDragStartY = useSharedValue(0)
  const contentDragCanDismiss = useSharedValue(false)
  // Why: fill mode needs the keyboard inset in React layout (not only the
  // reanimated translate) so height shrinks as the sheet lifts and the top
  // edge stays under the status bar.
  const [keyboardInset, setKeyboardInset] = useState(0)
  const { height: screenHeight } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  // Why: on wide/tablet canvases a full-width sheet looks stretched; cap it and
  // center it horizontally. Vertical bottom-anchoring (and all the drag/keyboard
  // transforms below) is unchanged, so phone behavior stays identical.
  const { isWideLayout, modalMaxWidth } = useResponsiveLayout()
  const insideModalHost = useInsideBottomDrawerModalHost()
  const fillHeight = fillAvailable
    ? resolveBottomDrawerFillHeight({
        screenHeight,
        topInset: insets.top,
        keyboardInset,
        topGap: spacing.lg
      })
    : undefined

  useEffect(() => {
    if (visible) {
      translateY.value = 0
      scrollOffsetY.value = 0
      progress.value = withTiming(1, { duration: SHOW_DURATION })
    } else {
      Keyboard.dismiss()
      setKeyboardInset(0)
      progress.value = withTiming(0, { duration: BOTTOM_DRAWER_HIDE_DURATION_MS }, (finished) => {
        if (finished) {
          runOnJS(onHidden)()
        }
      })
    }
  }, [onHidden, visible])

  // Why: KeyboardAvoidingView and useAnimatedKeyboard are both unreliable
  // inside Modal (iOS ignores KAV; Android needs adjustNothing for
  // useAnimatedKeyboard). Keyboard event listeners work on both platforms
  // and give us the exact height to shift the drawer by.
  useEffect(() => {
    // Pinned-under sheets stay visible for size but must not ride the keyboard —
    // only the top interactive sheet owns inset/lift.
    if (!visible || !interactive) {
      keyboardOffset.value = 0
      setKeyboardInset(0)
      return
    }

    function applyKeyboardHeight(keyboardHeight: number, duration = 0): void {
      const inset = resolveBottomDrawerKeyboardInset({
        keyboardHeight,
        bottomInset: insets.bottom,
        fillAvailable,
        platform: Platform.OS
      })
      setKeyboardInset(inset)
      if (duration > 0) {
        keyboardOffset.value = withTiming(inset, { duration })
      } else {
        keyboardOffset.value = inset
      }
    }

    // Why: fill sheets dock to the true keyboard top; autoFocus can raise the
    // keyboard before listeners attach. Seed only in fill mode so content-sized
    // outer sheets do not inherit a stale metrics height after an inner dismiss.
    if (fillAvailable) {
      const existing = Keyboard.metrics()
      if (existing != null && existing.height > 0) {
        applyKeyboardHeight(existing.height)
      }
    }

    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'

    const onShow = Keyboard.addListener(showEvent, (e) => {
      applyKeyboardHeight(e.endCoordinates.height, e.duration || 250)
    })
    const onHide = Keyboard.addListener(hideEvent, (e) => {
      setKeyboardInset(0)
      keyboardOffset.value = withTiming(0, { duration: e.duration || 250 })
    })

    return () => {
      onShow.remove()
      onHide.remove()
      keyboardOffset.value = 0
      setKeyboardInset(0)
    }
  }, [visible, interactive, insets.bottom, fillAvailable])

  const dismiss = useCallback(() => {
    Keyboard.dismiss()
    progress.value = withTiming(0, { duration: BOTTOM_DRAWER_HIDE_DURATION_MS }, (finished) => {
      if (finished) {
        runOnJS(onClose)()
      }
    })
  }, [onClose, progress])

  useEffect(() => {
    if (!visible || !interactive) {
      return
    }

    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      dismiss()
      return true
    })
    return () => sub.remove()
  }, [visible, interactive, dismiss])

  const scrollHandler = useAnimatedScrollHandler((event) => {
    scrollOffsetY.value = Math.max(event.contentOffset.y, 0)
  })

  const scrollGesture = Gesture.Native()
  const handlePanGesture = Gesture.Pan()
    .activeOffsetY([-8, 8])
    .simultaneousWithExternalGesture(scrollGesture)
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
          runOnJS(onClose)()
        })
      } else {
        translateY.value = withSpring(0, SPRING_CONFIG)
      }
    })
  const contentPanGesture = Gesture.Pan()
    .activeOffsetY([-8, 8])
    .simultaneousWithExternalGesture(scrollGesture)
    .onBegin(() => {
      contentDragStartY.value = 0
      contentDragCanDismiss.value = scrollOffsetY.value <= TOP_SCROLL_EPSILON
    })
    .onUpdate((e) => {
      // Why: action-sheet content can be taller than the drawer; downward drags
      // should scroll back to the top before they start dismissing the sheet.
      if (scrollOffsetY.value > TOP_SCROLL_EPSILON) {
        contentDragCanDismiss.value = false
        contentDragStartY.value = 0
        if (translateY.value !== 0) {
          translateY.value = withSpring(0, SPRING_CONFIG)
        }
        return
      }

      if (!contentDragCanDismiss.value) {
        contentDragCanDismiss.value = true
        contentDragStartY.value = e.translationY
      }

      const translationY = e.translationY - contentDragStartY.value
      if (translationY > 0) {
        translateY.value = translationY
      } else {
        translateY.value = translationY * RUBBER_BAND_FACTOR
      }
    })
    .onEnd((e) => {
      if (!contentDragCanDismiss.value || scrollOffsetY.value > TOP_SCROLL_EPSILON) {
        return
      }

      const translationY = e.translationY - contentDragStartY.value
      if (translationY > DISMISS_THRESHOLD || e.velocityY > 500) {
        const velocity = Math.max(e.velocityY, 800)
        const remaining = screenHeight - translationY
        const duration = Math.min(Math.max((remaining / velocity) * 1000, 120), 300)
        translateY.value = withTiming(screenHeight, { duration })
        progress.value = withTiming(0, { duration }, () => {
          runOnJS(onClose)()
        })
      } else {
        translateY.value = withSpring(0, SPRING_CONFIG)
      }
    })

  const drawerStyle = useAnimatedStyle(() => {
    // Why: fill mode already shrinks height by the keyboard inset and lifts via
    // marginBottom (layout). Also subtracting keyboardOffset here would double-
    // count and park the dock under the keys (input hidden).
    const keyboardShift = fillAvailable ? 0 : keyboardOffset.value
    return {
      transform: [
        {
          translateY:
            interpolate(progress.value, [0, 1], [screenHeight, 0], Extrapolation.CLAMP) +
            translateY.value -
            keyboardShift
        }
      ]
    }
  })

  const backdropStyle = useAnimatedStyle(() => {
    const dragFade = interpolate(translateY.value, [0, 300], [1, 0], Extrapolation.CLAMP)
    return { opacity: progress.value * dragFade }
  })

  // Why: the sheet renders through a full-screen native window (its own Modal
  // below, or the shared BottomDrawerModalHost) so it always covers the viewport
  // — even when mounted deep inside a ScrollView, where a plain absolute overlay
  // anchors to the scrolled content and clips the sheet. Show/hide is driven by
  // `progress` (animationType "none") so the reanimated exit animation runs before
  // the parent unmounts us.
  const handle = (
    <GestureDetector gesture={handlePanGesture}>
      <Animated.View
        style={styles.handleHitArea}
        accessibilityRole="button"
        accessibilityLabel="Dismiss drawer"
      >
        <View style={styles.handle} />
      </Animated.View>
    </GestureDetector>
  )

  const body = !contentScrollable ? (
    <>
      {handle}
      <View style={[styles.staticContent, fillAvailable && styles.staticContentFill]}>
        {children}
      </View>
    </>
  ) : dragContentToDismiss ? (
    <>
      {handle}
      <GestureDetector gesture={contentPanGesture}>
        <Animated.View collapsable={false}>
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
    </>
  ) : (
    <>
      {handle}
      <ScrollView
        bounces={false}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    </>
  )

  const overlay = (
    <Animated.View
      pointerEvents={visible && interactive ? 'auto' : 'none'}
      style={[styles.overlay, { zIndex, elevation: zIndex }]}
      accessibilityViewIsModal={interactive}
      aria-modal={interactive}
    >
      <GestureHandlerRootView style={styles.root}>
        <Animated.View
          // Why: pinned-under outer sheets keep progress=1 so size stays; hide
          // their backdrop so only the top interactive drawer dims the canvas.
          style={[styles.backdrop, interactive ? backdropStyle : { opacity: 0 }]}
        >
          {interactive ? <Pressable style={styles.backdropPressable} onPress={dismiss} /> : null}
        </Animated.View>

        <View style={[styles.anchor, isWideLayout && styles.anchorWide]} pointerEvents="box-none">
          <Animated.View
            style={[
              styles.drawer,
              fillAvailable ? styles.drawerFill : null,
              {
                width: '100%',
                maxWidth: isWideLayout ? modalMaxWidth : undefined,
                maxHeight: screenHeight - insets.top - spacing.lg,
                // Why: fill sheets shrink height AND lift with marginBottom so the
                // bottom edge sits on the keyboard top (height alone still leaves
                // the dock in the keyboard’s footprint). Non-fill sheets keep
                // the legacy translateY keyboard shift instead.
                height: fillHeight,
                marginBottom: fillAvailable ? keyboardInset : 0,
                paddingBottom:
                  fillAvailable && keyboardInset > 0 ? spacing.sm : insets.bottom + spacing.lg
              },
              drawerStyle
            ]}
          >
            {body}
            <View style={styles.bottomExtension} />
          </Animated.View>
        </View>
      </GestureHandlerRootView>
    </Animated.View>
  )

  // Why: inside a BottomDrawerModalHost the host owns the single native Modal;
  // rendering our own would stack modals and reintroduce the iOS present/dismiss
  // race the host exists to avoid. The host handles the Android back button.
  if (insideModalHost) {
    return overlay
  }

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={dismiss}>
      {overlay}
    </Modal>
  )
}
