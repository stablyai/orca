import { useEffect, useRef } from 'react'
import { Animated, Easing, Modal, Platform, Pressable } from 'react-native'
import { X } from 'lucide-react-native'
import { useWindowSafeAreaInsets } from '../../../layout/side-safe-area'
import { colors, feedback, radii, spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { PanZoomSize } from '../../../../../src/shared/pan-zoom-view'
import { MobilePanZoomImage } from '../../../components/MobilePanZoomImage'
import { REDUCED_MOTION_FADE_MS, SHEET_CURVE } from '../../../components/sheet-motion-values'
import { useReducedMotionEnabled } from '../../../platform/use-reduced-motion'

const VIEWER_EASING = Easing.bezier(...SHEET_CURVE)
const VIEWER_OPEN_MS = 250
const VIEWER_CLOSE_MS = 200

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
  const { style, stageStyle, close } = useViewerPresence(onClose)
  return (
    <Modal visible transparent animationType="none" onRequestClose={close}>
      <Animated.View style={[styles.backdrop, style]}>
        <Animated.View style={[styles.stage, stageStyle]}>
          <MobilePanZoomImage uri={uri} label={label} size={size} upscale={upscale} />
        </Animated.View>
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
    </Modal>
  )
}

function viewerTiming(value: Animated.Value, toValue: number, ms: number, reducedMotion: boolean) {
  return Animated.timing(value, {
    toValue,
    duration: reducedMotion ? REDUCED_MOTION_FADE_MS : ms,
    easing: VIEWER_EASING,
    useNativeDriver: Platform.OS !== 'web'
  })
}

// Grows from the centre while fading in, and shrinks back before the caller unmounts it; a close mid-open turns around from where it is.
function useViewerPresence(onClose: () => void) {
  const reducedMotion = useReducedMotionEnabled() === true
  const shown = useRef(new Animated.Value(0)).current
  const closing = useRef(false)
  useEffect(() => {
    if (closing.current) {
      return
    }
    const opening = viewerTiming(shown, 1, VIEWER_OPEN_MS, reducedMotion)
    opening.start()
    return () => opening.stop()
  }, [reducedMotion, shown])
  const close = () => {
    if (closing.current) {
      return
    }
    closing.current = true
    viewerTiming(shown, 0, VIEWER_CLOSE_MS, reducedMotion).start(({ finished }) => {
      if (finished) {
        onClose()
      }
    })
  }
  const scale = reducedMotion
    ? 1
    : shown.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1] })
  return { style: { opacity: shown }, stageStyle: { transform: [{ scale }] }, close }
}

const styles = themedStyleSheet(() => ({
  backdrop: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  stage: {
    flex: 1
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
