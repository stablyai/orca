import { useEffect, useRef } from 'react'
import { Animated, Easing, Modal, Platform, Pressable, useWindowDimensions } from 'react-native'
import { X } from 'lucide-react-native'
import { useWindowSafeAreaInsets } from '../../../layout/side-safe-area'
import { colors, feedback, radii, spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { PanZoomSize } from '../../../../../src/shared/pan-zoom-view'
import { MobilePanZoomImage } from '../../../components/MobilePanZoomImage'
import {
  IMAGE_VIEWER_DISMISS_MS,
  IMAGE_VIEWER_FADE_DISTANCE,
  imageViewerDismissTarget,
  shouldDismissImageViewer
} from '../../../components/image-viewer-swipe'
import {
  REDUCED_MOTION_DISMISS_FADE_MS,
  REDUCED_MOTION_FADE_MS,
  SHEET_CURVE
} from '../../../components/sheet-motion-values'
import { useReducedMotionEnabled } from '../../../platform/use-reduced-motion'
import type { MobilePanZoomDismiss } from '../../../components/use-mobile-pan-zoom'

const VIEWER_EASING = Easing.bezier(...SHEET_CURVE)
const VIEWER_OPEN_MS = 250
const VIEWER_CLOSE_MS = 200
const VIEWER_SETTLE = { stiffness: 280, damping: 34, mass: 1 } as const

/** Full-screen pinch, drag and double-tap zoom for chat and Markdown images, and Mermaid diagrams. */
export function MobileNativeChatImageViewer({
  uri,
  label,
  size,
  upscale,
  onClose
}: {
  uri: string
  label: string
  /** A drawing's own size; raster images measure themselves. */
  size?: PanZoomSize | null
  /** Let fit enlarge a vector past its natural size. */
  upscale?: boolean
  onClose: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const insets = useWindowSafeAreaInsets()
  const { height } = useWindowDimensions()
  const { backdropStyle, stageStyle, chromeStyle, close, dismiss } = useViewerPresence(
    onClose,
    height
  )
  return (
    <Modal visible transparent animationType="none" onRequestClose={close}>
      <Animated.View style={styles.root}>
        <Animated.View pointerEvents="none" style={[styles.backdrop, backdropStyle]} />
        <Animated.View style={[styles.stage, stageStyle]}>
          <MobilePanZoomImage
            uri={uri}
            label={label}
            size={size}
            upscale={upscale}
            dismiss={dismiss}
          />
        </Animated.View>
        <Animated.View pointerEvents="box-none" style={[styles.chrome, chromeStyle]}>
          <Pressable
            style={({ pressed }) => [
              styles.close,
              { top: insets.top + spacing.sm, right: insets.right + spacing.lg },
              pressed && { opacity: feedback.pressedOpacity }
            ]}
            onPress={close}
            accessibilityRole="button"
            accessibilityLabel={t('chat.nativeChatImageViewer.closeImage', 'Close image')}
          >
            <X size={22} color={colors.textPrimary} strokeWidth={2} />
          </Pressable>
        </Animated.View>
      </Animated.View>
    </Modal>
  )
}

const NATIVE_DRIVER = Platform.OS !== 'web'

function viewerTiming(value: Animated.Value, toValue: number, ms: number, reducedMotion: boolean) {
  return Animated.timing(value, {
    toValue,
    duration: reducedMotion ? REDUCED_MOTION_FADE_MS : ms,
    easing: VIEWER_EASING,
    useNativeDriver: NATIVE_DRIVER
  })
}

// Grows from the centre while fading in. A vertical swipe at the fitted size follows the finger,
// then leaves or springs back; Reduce Motion fades from where the finger stopped.
function useViewerPresence(onClose: () => void, windowHeight: number) {
  const reducedMotion = useReducedMotionEnabled() === true
  const shown = useRef(new Animated.Value(0)).current
  const dragY = useRef(new Animated.Value(0)).current
  const closing = useRef(false)
  const opening = useRef<Animated.CompositeAnimation | null>(null)
  const dragMotion = useRef<Animated.CompositeAnimation | null>(null)
  const onCloseRef = useRef(onClose)
  const heightRef = useRef(windowHeight)
  const reducedRef = useRef(reducedMotion)
  onCloseRef.current = onClose
  heightRef.current = windowHeight
  reducedRef.current = reducedMotion

  useEffect(() => {
    if (closing.current) {
      return
    }
    const fadeIn = viewerTiming(shown, 1, VIEWER_OPEN_MS, reducedMotion)
    opening.current = fadeIn
    fadeIn.start()
    return () => {
      fadeIn.stop()
      if (opening.current === fadeIn) {
        opening.current = null
      }
    }
  }, [reducedMotion, shown])

  const stopDrag = () => {
    dragMotion.current?.stop()
    dragMotion.current = null
  }

  const close = () => {
    if (closing.current) {
      return
    }
    closing.current = true
    opening.current?.stop()
    stopDrag()
    const timing = viewerTiming(shown, 0, VIEWER_CLOSE_MS, reducedRef.current)
    dragMotion.current = timing
    timing.start(({ finished }) => {
      if (finished) {
        onCloseRef.current()
      }
    })
  }

  const settle = () => {
    stopDrag()
    if (reducedRef.current) {
      dragY.setValue(0)
      return
    }
    const spring = Animated.spring(dragY, {
      toValue: 0,
      ...VIEWER_SETTLE,
      useNativeDriver: NATIVE_DRIVER
    })
    dragMotion.current = spring
    spring.start()
  }

  const dismiss: MobilePanZoomDismiss = {
    onMove: (translationY) => {
      if (closing.current) {
        return
      }
      stopDrag()
      dragY.setValue(translationY)
    },
    onRelease: (translationY, velocityY) => {
      if (closing.current) {
        return
      }
      if (!shouldDismissImageViewer(translationY, velocityY)) {
        settle()
        return
      }
      closing.current = true
      opening.current?.stop()
      stopDrag()
      if (reducedRef.current) {
        const fade = Animated.timing(shown, {
          toValue: 0,
          duration: REDUCED_MOTION_DISMISS_FADE_MS,
          easing: VIEWER_EASING,
          useNativeDriver: NATIVE_DRIVER
        })
        dragMotion.current = fade
        fade.start(({ finished }) => {
          if (finished) {
            onCloseRef.current()
          }
        })
        return
      }
      const fly = Animated.timing(dragY, {
        toValue: imageViewerDismissTarget(translationY, heightRef.current),
        duration: IMAGE_VIEWER_DISMISS_MS,
        easing: VIEWER_EASING,
        useNativeDriver: NATIVE_DRIVER
      })
      dragMotion.current = fly
      fly.start(({ finished }) => {
        if (finished) {
          onCloseRef.current()
        }
      })
    },
    onCancel: () => {
      if (!closing.current) {
        settle()
      }
    }
  }

  const dragFade = dragY.interpolate({
    inputRange: [-IMAGE_VIEWER_FADE_DISTANCE, 0, IMAGE_VIEWER_FADE_DISTANCE],
    outputRange: [0, 1, 0],
    extrapolate: 'clamp'
  })
  const scale = reducedMotion
    ? 1
    : shown.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1] })
  return {
    backdropStyle: { opacity: Animated.multiply(shown, dragFade) },
    stageStyle: { opacity: shown, transform: [{ translateY: dragY }, { scale }] },
    chromeStyle: { opacity: shown },
    close,
    dismiss
  }
}

const styles = themedStyleSheet(() => ({
  root: {
    flex: 1
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.bgBase
  },
  stage: {
    flex: 1
  },
  chrome: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0
  },
  // Page Pressables ignore hitSlop, so the button itself is the 44pt target.
  close: {
    position: 'absolute',
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
    backgroundColor: colors.bgRaised
  }
}))
