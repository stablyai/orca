import { View, Text, ActivityIndicator, type StyleProp, type ViewStyle } from 'react-native'
import { colors, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

import './usage-selectors'

/** A meter's fill: the rounded, clamped percent and its consumption colour, shared by every usage meter. */
export function usageBarFill(
  usedPercent: number | null,
  unavailable: boolean
): { used: number | null; color: string } {
  // Why: round then clamp so bar width, color, and label share one value (desktop parity).
  const used = usedPercent == null ? null : Math.max(0, Math.min(100, Math.round(usedPercent)))
  // Why: same consumption bands as desktop barColor (green <60, amber <80, red ≥80).
  const color =
    unavailable || used == null
      ? colors.textMuted
      : used >= 80
        ? colors.statusRed
        : used >= 60
          ? colors.statusAmber
          : colors.statusGreen
  return { used, color }
}

// Match desktop/harness consumption meters: fresh empty/green, depleted full/red.
export function UsageBar({
  label,
  usedPercent,
  unavailable,
  loading,
  resetText,
  wideLabel = false,
  style
}: {
  label: string
  usedPercent: number | null
  unavailable: boolean
  loading?: boolean
  resetText?: string | null
  /** For long pool names: the label sits on its own line above the track. */
  wideLabel?: boolean
  style?: StyleProp<ViewStyle>
}) {
  useMobileColorScheme()
  const { used, color } = usageBarFill(usedPercent, unavailable)
  return (
    <View style={[wideLabel ? styles.usageBarStack : styles.usageBarRow, style]}>
      <Text style={styles.usageLabel} numberOfLines={1}>
        {label}
      </Text>
      <View style={[styles.usageBarBody, !wideLabel && styles.usageBarBodyBeside]}>
        <View style={styles.usageBar}>
          <View style={styles.usageTrack}>
            <View
              style={[
                styles.usageFill,
                {
                  width: `${used ?? 0}%`,
                  backgroundColor: color
                }
              ]}
            />
          </View>
          {loading ? (
            <ActivityIndicator
              size="small"
              color={colors.textSecondary}
              style={styles.usageSpinner}
            />
          ) : (
            <Text style={styles.usageValue}>{unavailable || used == null ? '—' : `${used}%`}</Text>
          )}
        </View>
        {resetText ? (
          <Text style={styles.usageResetText} numberOfLines={1}>
            {resetText}
          </Text>
        ) : null}
      </View>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  usageBarRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs
  },
  usageBarStack: {
    gap: 2
  },
  usageBarBody: {
    gap: 2
  },
  usageBarBodyBeside: {
    flex: 1
  },
  usageBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  usageLabel: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    minWidth: 22
  },
  usageTrack: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.bgRaised,
    overflow: 'hidden'
  },
  usageFill: {
    height: '100%',
    borderRadius: 3
  },
  usageValue: {
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    width: 36,
    textAlign: 'right'
  },
  usageSpinner: {
    width: 36
  },
  usageResetText: {
    fontSize: typography.metaSize,
    color: colors.textMuted
  }
}))
