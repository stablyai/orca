import { View, Text, StyleSheet, ActivityIndicator } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { getUsageWindowResetLabel, type UsageWindowRow } from './account-usage-state'

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
  ManagedAccountProviderKey,
  UsageProviderKey,
  UsageProviderDescriptor,
  UsageWindowRow,
  UsageBarState
} from './account-usage-state'
export {
  decodeAccountsSnapshot,
  USAGE_PROVIDERS,
  USAGE_PROVIDER_IDS,
  DEFAULT_VISIBLE_USAGE_PROVIDERS,
  getUsageProviderDescriptor,
  getActiveProviderRateLimits,
  getInactiveProviderUsage,
  getProviderUsageWindows,
  getUsageWindowResetLabel,
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
  labelWidth,
  resetText
}: {
  label: string
  usedPercent: number | null
  unavailable: boolean
  loading?: boolean
  labelWidth?: number
  resetText?: string | null
}) {
  // Round+clamp so width/color/label share one value (desktop parity); a
  // non-finite value counts as no data so the bar never renders `width: "NaN%"`.
  const used =
    usedPercent == null || !Number.isFinite(usedPercent)
      ? null
      : Math.max(0, Math.min(100, Math.round(usedPercent)))
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
    <View style={styles.usageBarColumn}>
      <View style={styles.usageBar}>
        <Text
          style={[styles.usageLabel, labelWidth != null ? { width: labelWidth } : null]}
          numberOfLines={1}
        >
          {label}
        </Text>
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
  )
}

// Why: display-only providers can report a variable set of windows (Gemini
// named buckets, OpenCode Go monthly, others session/weekly). Render one bar
// per window stacked full-width, or a single loading/unavailable bar when a
// provider is mid-fetch with nothing yet.
export function UsageWindowBars({
  windows,
  fetching,
  now
}: {
  windows: UsageWindowRow[]
  fetching?: boolean
  now?: number
}) {
  if (windows.length === 0) {
    return <UsageBar label="—" usedPercent={null} unavailable={!fetching} loading={fetching} />
  }
  // Widen the label column for named buckets (e.g. "3.1 Flash Lite") so they
  // don't wrap in the 22px slot sized for "5h"/"7d".
  const labelWidth = windows.some((w) => w.label.length > 4) ? 76 : undefined
  return (
    <>
      {windows.map((w) => (
        <View style={styles.windowRow} key={w.key}>
          <UsageBar
            label={w.label}
            usedPercent={w.usedPercent}
            unavailable={!Number.isFinite(w.usedPercent)}
            labelWidth={labelWidth}
            resetText={now == null ? null : getUsageWindowResetLabel(w, now)}
          />
        </View>
      ))}
    </>
  )
}

const styles = StyleSheet.create({
  windowRow: {
    flexDirection: 'row',
    alignItems: 'center'
  },
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
  },
  // Why: indented past the window label so the countdown aligns with the
  // start of the track above it.
  usageResetText: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    marginLeft: 22 + spacing.xs
  }
})
