import { View, Text, StyleSheet, ActivityIndicator } from 'react-native'
import { colors, spacing, textStyles } from '../theme/mobile-theme'

// Pure types and selectors live in account-usage-state.ts (no RN imports) so
// they are unit-testable; re-exported here so existing import sites are stable.
export type {
  RateLimitWindow,
  ProviderRateLimits,
  InactiveAccountUsage,
  ClaudeAccountSummary,
  CodexAccountSummary,
  AccountsSnapshot,
  ProviderKey,
  UsageBarState
} from './account-usage-state'
export {
  decodeAccountsSnapshot,
  getActiveProviderRateLimits,
  getInactiveProviderUsage,
  getUsageBarState,
  getWindowResetLabel,
  hasActiveProviderUsage,
  hasRenderableUsage
} from './account-usage-state'

// Why: matches desktop StatusBar — bars show percent used (consumption), same
// as Claude/Codex harness meters. Fresh account is empty/green; depleted is
// full/red.
export function UsageBar({
  label,
  usedPercent,
  unavailable,
  loading,
  resetText,
  layout = 'inline'
}: {
  label: string
  usedPercent: number | null
  unavailable: boolean
  loading?: boolean
  resetText?: string | null
  /** `stacked` puts label, reset time and percent on one line over a full-width meter. */
  layout?: 'inline' | 'stacked'
}) {
  // Why: round then clamp so bar width, color, and label share one value (desktop parity).
  const used = usedPercent == null ? null : Math.max(0, Math.min(100, Math.round(usedPercent)))
  // Why: same consumption bands as desktop barColor (green <60, amber <80, red ≥80).
  const barColor =
    used == null
      ? colors.textMuted
      : used >= 80
        ? colors.statusRed
        : used >= 60
          ? colors.statusAmber
          : colors.statusGreen
  const valueText = unavailable || used == null ? '—' : `${used}%`
  const track = (
    <View
      style={[
        styles.usageTrack,
        layout === 'stacked' ? styles.usageTrackStacked : styles.usageTrackInline
      ]}
      accessibilityRole="progressbar"
      accessibilityLabel={`${label} usage`}
      accessibilityValue={used == null ? undefined : { min: 0, max: 100, now: used }}
    >
      <View
        style={[
          styles.usageFill,
          {
            width: `${used ?? 0}%`,
            backgroundColor: unavailable ? colors.textMuted : barColor
          }
        ]}
      />
    </View>
  )
  const value = loading ? (
    <ActivityIndicator size="small" color={colors.textSecondary} style={styles.usageSpinner} />
  ) : (
    <Text style={[styles.usageValue, layout === 'stacked' && styles.stackedValue]}>
      {valueText}
    </Text>
  )
  if (layout === 'stacked') {
    return (
      <View style={styles.stacked}>
        <View style={styles.stackedLine}>
          <Text style={styles.stackedLabel}>{label}</Text>
          <Text style={styles.stackedReset} numberOfLines={1}>
            {resetText ?? ''}
          </Text>
          {value}
        </View>
        {track}
      </View>
    )
  }
  return (
    <View style={styles.usageBarColumn}>
      <View style={styles.usageBar}>
        <Text style={styles.usageLabel}>{label}</Text>
        {track}
        {value}
      </View>
      {resetText ? (
        <Text style={styles.usageResetText} numberOfLines={1}>
          {resetText}
        </Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  usageBarColumn: {
    flex: 1,
    gap: 2
  },
  usageBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  usageLabel: {
    ...textStyles.caption,
    color: colors.textMuted,
    width: 22
  },
  usageTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.fill,
    overflow: 'hidden'
  },
  usageTrackInline: { flex: 1 },
  // No `flex` here: in a column it sets the height basis, which collapses the 6 pt track on web.
  usageTrackStacked: { alignSelf: 'stretch' },
  usageFill: {
    height: '100%',
    borderRadius: 3
  },
  usageValue: {
    ...textStyles.caption,
    color: colors.textSecondary,
    minWidth: 36,
    textAlign: 'right',
    fontVariant: ['tabular-nums']
  },
  usageSpinner: {
    width: 36
  },
  // Why: indented past the window label so the countdown aligns with the
  // start of the track above it.
  usageResetText: {
    ...textStyles.caption,
    color: colors.textMuted,
    marginLeft: 22 + spacing.xs
  },
  stacked: {
    gap: 6
  },
  stackedLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm
  },
  stackedLabel: {
    ...textStyles.footnote,
    fontWeight: '500',
    color: colors.textSecondary,
    fontVariant: ['tabular-nums']
  },
  stackedValue: {
    ...textStyles.footnote,
    fontWeight: '500',
    color: colors.textPrimary
  },
  stackedReset: {
    ...textStyles.footnote,
    flex: 1,
    minWidth: 0,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  }
})
