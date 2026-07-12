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

// Why: matches desktop StatusBar — bars show percent used (consumption), same
// as Claude/Codex harness meters. Fresh account is empty/green; depleted is
// full/red.
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
  return (
    <View style={styles.usageBar}>
      <Text style={styles.usageLabel}>{label}</Text>
      <View style={styles.usageTrack}>
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
      {loading ? (
        <ActivityIndicator size="small" color={colors.textSecondary} style={styles.usageSpinner} />
      ) : (
        <Text style={styles.usageValue}>{unavailable || used == null ? '—' : `${used}%`}</Text>
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
