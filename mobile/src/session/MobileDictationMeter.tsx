import { useSyncExternalStore } from 'react'
import { Text, View } from 'react-native'
import { DICTATION_GRAPES } from '../../../src/shared/dictation-audio-meter'
import {
  useMobileDictationMeterState,
  type MobileDictationMeter
} from '../hooks/mobile-dictation-meter'
import { useNow } from '../hooks/use-now'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { colors, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

type MeterProps = { readonly meter: MobileDictationMeter }

// Reduce Motion holds the level at rest; clipping still tints.
function useMeterEnergy(meter: MobileDictationMeter): { energy: number; isClipping: boolean } {
  useMobileColorScheme()
  const { level, isClipping } = useMobileDictationMeterState(meter)
  return { energy: useReducedMotionEnabled() === false ? level : 0, isClipping }
}

// Desktop's nine dots, red while the mic clips.
export function MobileDictationGrapes({ meter, dotSize }: MeterProps & { dotSize: number }) {
  const { energy, isClipping } = useMeterEnergy(meter)
  return (
    <View
      style={styles.grapes}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {DICTATION_GRAPES.map((grape, index) => (
        <View
          key={index}
          style={{
            width: dotSize,
            height: dotSize,
            borderRadius: dotSize / 2,
            backgroundColor: isClipping ? colors.statusRed : colors.textSecondary,
            opacity: 0.85,
            transform: [
              { translateY: energy * grape.lift * 2.5 },
              { scale: grape.base + energy * grape.response * 1.15 }
            ]
          }}
        />
      ))}
    </View>
  )
}

export function MobileDictationTimer({ meter }: MeterProps) {
  useMobileColorScheme()
  const startedAt = useSyncExternalStore(meter.subscribe, () => meter.getSnapshot().startedAt)
  const now = useNow(250)
  // The hook starts the meter in an effect, so the first recording frame may still read 0.
  const elapsedSeconds = startedAt === 0 ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000))
  const minutes = Math.floor(elapsedSeconds / 60)
  const seconds = String(elapsedSeconds % 60).padStart(2, '0')
  return <Text style={styles.timer}>{`${minutes}:${seconds}`}</Text>
}

// The buffered command field has no status row, so its mic carries the level as a halo; it overlays the mic's box at the origin.
export function MobileDictationHalo({ meter, size }: MeterProps & { size: number }) {
  const { energy, isClipping } = useMeterEnergy(meter)
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: isClipping ? colors.statusRed : colors.textPrimary,
        opacity: 0.1 + energy * 0.18,
        transform: [{ scale: 1 + energy * 0.32 }]
      }}
    />
  )
}

const styles = themedStyleSheet(() => ({
  grapes: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    height: 24
  },
  timer: {
    color: colors.textSecondary,
    fontSize: typography.metaSize + 1,
    fontVariant: ['tabular-nums'],
    fontWeight: '500'
  }
}))
