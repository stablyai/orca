import { View, Text, StyleSheet, ActivityIndicator } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'

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
  getActiveProviderRateLimits,
  getInactiveProviderUsage,
  getUsageBarState,
  hasActiveProviderUsage,
  hasRenderableUsage
} from './account-usage-state'

// Why: matches desktop StatusBar convention — bars show percent remaining
// (so a fresh account renders full, a depleted one renders empty), not
// percent used. Color thresholds invert accordingly.
export function UsageBar({
  label,
  usedPercent,
  unavailable,
  loading
}: {
  label: string
  usedPercent: number | null
  unavailable: boolean
  loading?: boolean
}) {
  const remaining = usedPercent == null ? null : Math.max(0, Math.min(100, 100 - usedPercent))
  const barColor =
    remaining == null
      ? colors.textMuted
      : remaining <= 10
        ? colors.statusRed
        : remaining <= 30
          ? colors.statusAmber
          : colors.statusGreen
  return (
    <View style={styles.usageBar}>
      <Text style={styles.usageLabel}>{label}</Text>
      <View style={styles.usageTrack}>
        <View
          style={[
            styles.usageFill,
            {
              width: `${remaining ?? 0}%`,
              backgroundColor: unavailable ? colors.textMuted : barColor
            }
          ]}
        />
      </View>
      {loading ? (
        <ActivityIndicator size="small" color={colors.textSecondary} style={styles.usageSpinner} />
      ) : (
        <Text style={styles.usageValue}>
          {unavailable || remaining == null ? '—' : `${Math.round(remaining)}%`}
        </Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  usageBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flex: 1
  },
  usageLabel: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    width: 22
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
  }
})
