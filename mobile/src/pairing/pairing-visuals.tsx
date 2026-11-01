import { useEffect } from 'react'
import { ActivityIndicator, Text, View, type StyleProp, type TextStyle } from 'react-native'
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming
} from 'react-native-reanimated'
import { Check } from 'lucide-react-native'
import { SHEET_CURVE } from '../components/sheet-motion-values'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { pairScanStyles as scanStyles } from '../pair-scan-styles'
import { colors, radii } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

/** The reticle's squeeze on a decoded QR, before the screen turns to Connecting. */
export const SCAN_DECODE_BEAT_MS = 160
/** How long the check stays up before pairing moves on, so the success registers. */
export const PAIRING_SUCCESS_HOLD_MS = 450
const REDUCED_MOTION_MS = 150
const SHEET_EASING = Easing.bezier(...SHEET_CURVE)

export function waitForBeat(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** One numbered instruction above the scanner. */
export function Step({ number, text }: { number: number; text: string }) {
  useMobileColorScheme()
  return (
    <View style={scanStyles.step}>
      <View style={scanStyles.stepBadge}>
        <Text style={scanStyles.stepNumber}>{number}</Text>
      </View>
      <Text style={scanStyles.stepText}>{text}</Text>
    </View>
  )
}

/** The QR guide's four corners; they squeeze in once a code decodes, or dim under Reduce Motion. */
export function ScanReticle({ size, decoded }: { size: number; decoded: boolean }) {
  useMobileColorScheme()
  const reducedMotion = useReducedMotionEnabled() === true
  const progress = useSharedValue(0)
  useEffect(() => {
    progress.value = withTiming(decoded ? 1 : 0, {
      duration: reducedMotion ? REDUCED_MOTION_MS : SCAN_DECODE_BEAT_MS,
      easing: SHEET_EASING
    })
  }, [decoded, progress, reducedMotion])
  const frameStyle = useAnimatedStyle(
    () =>
      reducedMotion
        ? { opacity: 1 - progress.value * 0.5 }
        : { transform: [{ scale: 1 - progress.value * 0.06 }] },
    [progress, reducedMotion]
  )
  return (
    <View style={scanStyles.reticle} pointerEvents="none">
      <Animated.View style={[scanStyles.reticleFrame, { width: size, height: size }, frameStyle]}>
        <View style={[scanStyles.corner, scanStyles.cornerTL]} />
        <View style={[scanStyles.corner, scanStyles.cornerTR]} />
        <View style={[scanStyles.corner, scanStyles.cornerBL]} />
        <View style={[scanStyles.corner, scanStyles.cornerBR]} />
      </Animated.View>
    </View>
  )
}

/** The spinner and its label while pairing connects; both turn to Connected, with a check, once the desktop accepts. */
export function PairingProgress({
  succeeded,
  connectingLabel,
  labelStyle
}: {
  succeeded: boolean
  connectingLabel: string
  labelStyle: StyleProp<TextStyle>
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const reducedMotion = useReducedMotionEnabled() === true
  const shown = useSharedValue(0)
  useEffect(() => {
    if (!succeeded) {
      return
    }
    shown.value = reducedMotion
      ? withTiming(1, { duration: REDUCED_MOTION_MS })
      : withSpring(1, { duration: 400, dampingRatio: 0.8 })
  }, [reducedMotion, shown, succeeded])
  const checkStyle = useAnimatedStyle(
    () => ({
      opacity: shown.value,
      transform: [{ scale: reducedMotion ? 1 : 0.5 + shown.value * 0.5 }]
    }),
    [reducedMotion, shown]
  )
  return (
    <>
      {succeeded ? (
        <Animated.View style={[styles.check, checkStyle]}>
          <Check size={22} color={colors.bgBase} strokeWidth={3} />
        </Animated.View>
      ) : (
        <ActivityIndicator size="large" color={colors.textSecondary} />
      )}
      <Text style={labelStyle}>
        {succeeded ? t('connection.connectionHealth.connected', 'Connected') : connectingLabel}
      </Text>
    </>
  )
}

const styles = themedStyleSheet(() => ({
  check: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.statusGreen
  }
}))
