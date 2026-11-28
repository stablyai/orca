import { View, Text, ActivityIndicator, type StyleProp, type ViewStyle } from 'react-native'
import { spacing, typography, type MobilePalette } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'

import {
  clampUsedPercent,
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../src/shared/agent-usage/display/usage-percentage-display'
import { useUsagePercentageDisplay } from './usage-percentage-display-preference'
import type { Translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { UsagePaceTick } from './UsagePaceTick'

import './usage-selectors'

/** A meter's fill: the shown percent (used or left) and its consumption colour, shared by every usage meter. */
export function usageBarFill(
  usedPercent: number | null,
  unavailable: boolean,
  display: UsagePercentageDisplay,
  colors: MobilePalette
): { shown: number | null; color: string } {
  // Why: round then clamp so bar width, color, and label share one value (desktop parity).
  const used = usedPercent == null ? null : clampUsedPercent(usedPercent)
  // Why: same consumption bands as desktop barColor (green <60, amber <80, red ≥80).
  const color =
    unavailable || used == null
      ? colors.textMuted
      : used >= 80
        ? colors.statusRed
        : used >= 60
          ? colors.statusAmber
          : colors.statusGreen
  // Colour follows consumption either way, so a nearly empty remainder stays red (desktop parity).
  return {
    shown: usedPercent == null ? null : getDisplayedUsagePercentage(usedPercent, display),
    color
  }
}

/** "34%" when counting used, "66% left" when counting what remains, so a bare number stays unambiguous. */
/** A percent's consumption color without drawing a bar, for meters with their own track. */
export function usageBandColor(usedPercent: number | null, colors: MobilePalette): string {
  if (usedPercent == null || !Number.isFinite(usedPercent)) {
    return colors.textMuted
  }
  return usageBarFill(usedPercent, false, 'used', colors).color
}

export function formatUsageBarValue(
  shown: number | null,
  display: UsagePercentageDisplay,
  t: Translate
): string {
  if (shown == null) {
    return '—'
  }
  return display === 'remaining'
    ? t('accounts.usage.percentLeft', '{{value}}% left', { value: shown })
    : `${shown}%`
}

// Match desktop/harness consumption meters: fresh empty/green, depleted full/red.
export function UsageBar({
  label,
  usedPercent,
  unavailable,
  loading,
  resetText,
  labelWidth,
  wideLabel = false,
  display: displayOverride,
  paceMarkerPercent = null,
  fillColor,
  style
}: {
  label: string
  usedPercent: number | null
  unavailable: boolean
  loading?: boolean
  resetText?: string | null
  /** 0 hides the label; a positive width fixes it. */
  labelWidth?: number
  /** For long pool names: the label sits on its own line above the track. */
  wideLabel?: boolean
  /** Overrides the accounts used/remaining preference, for meters with their own toggle. */
  display?: UsagePercentageDisplay
  /** Tick where an even burn would put the fill (0–100, in the bar's display); null hides it. */
  paceMarkerPercent?: number | null
  /** Overrides the used-level band, e.g. with the window's pace colour. */
  fillColor?: string
  style?: StyleProp<ViewStyle>
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const preferredDisplay = useUsagePercentageDisplay()
  const display = displayOverride ?? preferredDisplay
  const { shown, color } = usageBarFill(usedPercent, unavailable, display, colors)
  const showLabel = labelWidth === 0 ? false : label !== ''
  return (
    <View style={[wideLabel ? styles.usageBarStack : styles.usageBarRow, style]}>
      {showLabel ? (
        <Text
          style={[
            styles.usageLabel,
            labelWidth != null && labelWidth > 0 ? { width: labelWidth } : null
          ]}
          numberOfLines={1}
        >
          {label}
        </Text>
      ) : null}
      <View style={[styles.usageBarBody, !wideLabel && styles.usageBarBodyBeside]}>
        <View style={styles.usageBar}>
          <View style={styles.usageTrackSlot}>
            <View style={styles.usageTrack}>
              <View
                style={[
                  styles.usageFill,
                  {
                    width: `${shown ?? 0}%`,
                    backgroundColor: fillColor ?? color
                  }
                ]}
              />
            </View>
            {paceMarkerPercent != null ? <UsagePaceTick percent={paceMarkerPercent} /> : null}
          </View>
          {loading ? (
            <ActivityIndicator
              size="small"
              color={colors.textSecondary}
              style={styles.usageSpinner}
            />
          ) : (
            <Text style={styles.usageValue}>
              {formatUsageBarValue(unavailable ? null : shown, display, t)}
            </Text>
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

const stylesSheet = themedStyleSheet((colors) => ({
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
  usageTrackSlot: {
    flex: 1,
    justifyContent: 'center'
  },
  usageTrack: {
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
    minWidth: 36,
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
