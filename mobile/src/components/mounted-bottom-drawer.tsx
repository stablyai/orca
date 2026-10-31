import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import {
  View,
  Pressable,
  useWindowDimensions,
  ScrollView,
  Keyboard,
  Modal,
  Platform
} from 'react-native'
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
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { resolveBottomDrawerFillHeight } from './bottom-drawer-fill-height'
import { resolveBottomDrawerKeyboardInset } from './bottom-drawer-keyboard-inset'
import {
  BOTTOM_DRAWER_EASING,
  BOTTOM_DRAWER_HIDE_DURATION_MS,
  BOTTOM_DRAWER_SHOW_DURATION_MS
} from './bottom-drawer-constants'
import { AutoHeight } from './AutoHeight'
import { bottomDrawerStyles as styles } from './bottom-drawer-styles'
import {
  useBottomDrawerModalHost,
  useBottomDrawerModalHostBackClaim
} from './bottom-drawer-modal-host-scope'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { useWindowSafeAreaInsets } from '../layout/side-safe-area'
import { useBackClaim } from '../navigation/use-back-claim'
import { currentSoftKeyboardHeight, subscribeSoftKeyboard } from '../platform/keyboard-occlusion'
import { hostOs } from '../platform/host-os'

const DISMISS_THRESHOLD = 80
const SPRING_CONFIG = { damping: 28, stiffness: 400 }
// Damp upward pull with rubber-band factor to signal drawer cannot expand further.
const RUBBER_BAND_FACTOR = 0.25
const TOP_SCROLL_EPSILON = 1
const SHOW_TIMING = { duration: BOTTOM_DRAWER_SHOW_DURATION_MS, easing: BOTTOM_DRAWER_EASING }
const HIDE_TIMING = { duration: BOTTOM_DRAWER_HIDE_DURATION_MS, easing: BOTTOM_DRAWER_EASING }
// The sheet travels its own height plus this, not the whole screen, so short sheets don't rush.
const OFFSCREEN_MARGIN = 48
// The grabber row above the content: its padding plus the 5 pt bar.
const HANDLE_AREA_HEIGHT = spacing.sm + 5 + spacing.md

export type MountedBottomDrawerProps = {
  visible: boolean
  onClose: () => void
  onHidden: () => void
  children: ReactNode
  dragContentToDismiss?: boolean
  contentScrollable?: boolean
  fillAvailable?: boolean
  // Pinned-under sheet preserves size but must not receive touches, backdrop or keyboard lift.
  interactive?: boolean
  zIndex?: number
  /** When this changes to a non-null value the content scrolls back to its top, e.g. a new page. */
  scrollResetKey?: string | null
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
  zIndex = 1000,
  scrollResetKey = null
}: MountedBottomDrawerProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const translateY = useSharedValue(0)
  const progress = useSharedValue(0)
  const keyboardOffset = useSharedValue(0)
  const scrollOffsetY = useSharedValue(0)
  const scrollRef = useRef<ScrollView>(null)
  useEffect(() => {
    if (scrollResetKey !== null) {
      scrollRef.current?.scrollTo({ y: 0, animated: false })
      scrollOffsetY.value = 0
    }
  }, [scrollOffsetY, scrollResetKey])
  const contentDragStartY = useSharedValue(0)
  const contentDragCanDismiss = useSharedValue(false)
  // Use React layout inset for fill height shrink plus lift; translation alone can cross status-bar gap.
  const [keyboardInset, setKeyboardInset] = useState(0)
  const { height: screenHeight } = useWindowDimensions()
  const sheetHeight = useSharedValue(screenHeight)
  const insets = useWindowSafeAreaInsets()
  // Cap/center tablet width while retaining phone’s bottom anchor and drag/keyboard transforms.
  const { isWideLayout, modalMaxWidth } = useResponsiveLayout()
  const insideModalHost = useBottomDrawerModalHost() !== null
  const fillHeight = fillAvailable
    ? resolveBottomDrawerFillHeight({
        screenHeight,
        topInset: insets.top,
        keyboardInset,
        topGap: spacing.lg
      })
    : undefined

  // Remount on picker handback to heal stale native view binding; unchanged/nudged shared-value writes cannot repaint (device-verified).
  // Pinned sheet holds target progress while covered; seed fresh view from authoritative shared values because swap 166ms precedes enter animation 180ms.
  const [windowEpoch, setWindowEpoch] = useState(0)
  const wasInteractiveRef = useRef(interactive)
  useEffect(() => {
    const tookWindowBack = visible && interactive && !wasInteractiveRef.current
    wasInteractiveRef.current = interactive
    if (!tookWindowBack) {
      return
    }
    translateY.value = 0
    progress.value = withTiming(1, SHOW_TIMING)
    setWindowEpoch((epoch) => epoch + 1)
  }, [interactive, visible])

  useEffect(() => {
    if (visible) {
      translateY.value = 0
      scrollOffsetY.value = 0
      progress.value = withTiming(1, SHOW_TIMING)
    } else {
      Keyboard.dismiss()
      setKeyboardInset(0)
      progress.value = withTiming(0, HIDE_TIMING, (finished) => {
        if (finished) {
          runOnJS(onHidden)()
        }
      })
    }
  }, [onHidden, visible])

  // Use keyboard seam events: iOS Modal ignores KAV and Android useAnimatedKeyboard needs adjustNothing; page seam uses shell measurements.
  useEffect(() => {
    // Only top interactive sheet owns keyboard inset/lift; pinned-under sheet stays laid out without moving.
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
        platform: hostOs()
      })
      setKeyboardInset(inset)
      if (duration > 0) {
        keyboardOffset.value = withTiming(inset, { duration })
      } else {
        keyboardOffset.value = inset
      }
    }

    // Seed fill sheets (autoFocus may precede listeners) and page sheets (focus moving under an open IME sends no event); native content sheets own a Modal window, where stale metrics would stick.
    if (fillAvailable || Platform.OS === 'web') {
      const existing = currentSoftKeyboardHeight()
      if (existing > 0) {
        applyKeyboardHeight(existing)
      }
    }

    const unsubscribe = subscribeSoftKeyboard(
      (height, duration) => {
        applyKeyboardHeight(height, duration || 250)
      },
      (duration) => {
        setKeyboardInset(0)
        keyboardOffset.value = withTiming(0, { duration: duration || 250 })
      }
    )

    return () => {
      unsubscribe()
      keyboardOffset.value = 0
      setKeyboardInset(0)
    }
  }, [visible, interactive, insets.bottom, fillAvailable])

  const dismiss = useCallback(() => {
    // Never restart hide mid-close: cancellation prevents onHidden and leaves invisible Modal swallowing taps (Android Back).
    if (!visible) {
      return
    }
    Keyboard.dismiss()
    progress.value = withTiming(0, HIDE_TIMING, (finished) => {
      if (finished) {
        runOnJS(onClose)()
      }
    })
  }, [onClose, progress, visible])

  // Top interactive sheet claims native/shell Back so Android closes drawer rather than screen; pinned-under sheet never owns key.
  useBackClaim(
    visible && interactive
      ? () => {
          dismiss()
          return true
        }
      : null
  )
  useBottomDrawerModalHostBackClaim(visible && interactive ? dismiss : null)

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
      // Scroll tall content back to top before downward drag dismisses sheet.
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
    // Fill layout already shrinks/lifts via inset and marginBottom; subtracting keyboardOffset again hides dock under keys.
    const keyboardShift = fillAvailable ? 0 : keyboardOffset.value
    return {
      transform: [
        {
          translateY:
            interpolate(
              progress.value,
              [0, 1],
              [Math.min(sheetHeight.value + OFFSCREEN_MARGIN, screenHeight), 0],
              Extrapolation.CLAMP
            ) +
            translateY.value -
            keyboardShift
        }
      ]
    }
  }, [progress, translateY, keyboardOffset, screenHeight, fillAvailable, sheetHeight])

  const backdropStyle = useAnimatedStyle(() => {
    const dragFade = interpolate(translateY.value, [0, 300], [1, 0], Extrapolation.CLAMP)
    return { opacity: progress.value * dragFade }
  }, [progress, translateY])

  // Use full-screen native Modal (own/shared) to escape nested ScrollView clipping; progress drives animationType:none so exit finishes before unmount.
  const handle = (
    <GestureDetector gesture={handlePanGesture}>
      <Animated.View
        style={styles.handleHitArea}
        accessibilityRole="button"
        accessibilityLabel={t('components.mountedBottomDrawer.dismissDrawer', 'Dismiss drawer')}
      >
        <View style={styles.handle} />
      </Animated.View>
    </GestureDetector>
  )

  const content = !contentScrollable ? (
    <View style={[styles.staticContent, fillAvailable && styles.staticContentFill]}>
      {children}
    </View>
  ) : dragContentToDismiss ? (
    <GestureDetector gesture={contentPanGesture}>
      <Animated.View collapsable={false} style={styles.scrollFrame}>
        <GestureDetector gesture={scrollGesture}>
          <Animated.ScrollView
            ref={scrollRef}
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
  ) : (
    <ScrollView
      ref={scrollRef}
      bounces={false}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  )

  // Content-sized sheets ease to a new height when what they show changes; fill sheets have a fixed one.
  const contentCap =
    screenHeight - insets.top - spacing.lg - (insets.bottom + spacing.lg) - HANDLE_AREA_HEIGHT
  const body = (
    <>
      {handle}
      {fillAvailable ? content : <AutoHeight maxHeight={contentCap}>{content}</AutoHeight>}
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
          // Hide pinned-under backdrop while keeping progress 1 for size; only top sheet dims canvas.
          style={[styles.backdrop, interactive ? backdropStyle : { opacity: 0 }]}
        >
          {interactive ? <Pressable style={styles.backdropPressable} onPress={dismiss} /> : null}
        </Animated.View>

        <View
          style={[
            styles.anchor,
            isWideLayout && styles.anchorWide,
            { paddingLeft: insets.left, paddingRight: insets.right }
          ]}
          pointerEvents="box-none"
        >
          <Animated.View
            // Why: remount per window hand-back — see the windowEpoch effect.
            key={windowEpoch}
            // The sheet names itself so a check can find it without reading its styling.
            testID="bottom-drawer-sheet"
            style={[
              styles.drawer,
              fillAvailable ? styles.drawerFill : null,
              {
                width: '100%',
                maxWidth: isWideLayout ? modalMaxWidth : undefined,
                maxHeight: screenHeight - insets.top - spacing.lg,
                // Fill shrinks height and adds marginBottom to align bottom above keys; content-sized mode retains translateY shift.
                height: fillHeight,
                marginBottom: fillAvailable ? keyboardInset : 0,
                paddingBottom:
                  fillAvailable && keyboardInset > 0 ? spacing.sm : insets.bottom + spacing.lg
              },
              drawerStyle
            ]}
            onLayout={(event) => {
              sheetHeight.value = event.nativeEvent.layout.height
            }}
          >
            {body}
            <View style={styles.bottomExtension} />
          </Animated.View>
        </View>
      </GestureHandlerRootView>
    </Animated.View>
  )

  // Shared host owns sole Modal/Android Back; nested Modal would restore iOS presentation race.
  if (insideModalHost) {
    return overlay
  }

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={dismiss}>
      {overlay}
    </Modal>
  )
}
