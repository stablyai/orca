import { View, Text, StyleSheet, ActivityIndicator } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  getActiveAdditionalProviders,
  getAdditionalProviderUsageRows,
  type AccountsSnapshot,
  type AdditionalUsageProviderKey
} from './account-usage-state'

// Re-export pure account-usage-state selectors/types to keep imports stable and tests free of RN.
export type {
  RateLimitWindow,
  ProviderRateLimits,
  InactiveAccountUsage,
  ClaudeAccountSummary,
  CodexAccountSummary,
  AccountsSnapshot,
  ProviderKey,
  UsageBarState,
  AdditionalUsageProviderKey,
  AdditionalProviderUsageBar,
  AdditionalProviderUsageRow,
  ActiveAdditionalProvider
} from './account-usage-state'
export {
  decodeAccountsSnapshot,
  getActiveProviderRateLimits,
  getInactiveProviderUsage,
  getUsageBarState,
  getWindowResetLabel,
  hasActiveProviderUsage,
  hasRenderableUsage,
  getActiveAdditionalProviders,
  getAdditionalProviderUsageRows,
  hasAnyRenderableUsage
} from './account-usage-state'

// Match desktop/harness consumption meters: fresh empty/green, depleted full/red.
export function UsageBar({
  label,
  usedPercent,
  unavailable,
  loading,
  resetText,
  labelWidth = 22
}: {
  label: string
  usedPercent: number | null
  unavailable: boolean
  loading?: boolean
  resetText?: string | null
  labelWidth?: number
}) {
  useMobileColorScheme()
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
    <View style={styles.usageBarColumn}>
      <View style={styles.usageBar}>
        <Text style={[styles.usageLabel, { width: labelWidth }]}>{label}</Text>
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
        <Text
          style={[styles.usageResetText, { marginLeft: labelWidth + spacing.xs }]}
          numberOfLines={1}
        >
          {resetText}
        </Text>
      ) : null}
    </View>
  )
}

const ADDITIONAL_PROVIDER_TITLES: Record<AdditionalUsageProviderKey, string> = {
  antigravity: 'Antigravity',
  gemini: 'Gemini',
  cursor: 'Cursor',
  grok: 'Grok',
  opencodeGo: 'OpenCode Go',
  kimi: 'Kimi',
  minimax: 'MiniMax',
  zcode: 'Z.ai'
}

function usageLabelWidth(label: string): number {
  return Math.max(22, label.length * 8)
}

export function AdditionalProvidersUsageSections({
  snapshot,
  now
}: {
  snapshot: AccountsSnapshot
  now: number
}) {
  useMobileColorScheme()
  const providers = getActiveAdditionalProviders(snapshot)
  if (providers.length === 0) {
    return null
  }
  return (
    <>
      {providers.map((entry) => {
        const rows = getAdditionalProviderUsageRows(entry.limits, now)
        return (
          <View key={entry.key} style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionHeading}>{ADDITIONAL_PROVIDER_TITLES[entry.key]}</Text>
            </View>
            <View style={styles.card}>
              {rows.map((row, index) => (
                <View key={`${entry.key}:${row.title}:${index}`}>
                  {index > 0 ? <View style={styles.separator} /> : null}
                  <View style={styles.row}>
                    <View style={styles.rowMain}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {row.title}
                      </Text>
                      {row.bars.length > 0 ? (
                        <View style={styles.usageRow}>
                          {row.bars.map((bar, barIndex) => (
                            <UsageBar
                              key={`${bar.label}:${barIndex}`}
                              label={bar.label}
                              usedPercent={bar.usedPercent}
                              unavailable={bar.unavailable}
                              loading={bar.loading}
                              resetText={bar.resetText}
                              labelWidth={usageLabelWidth(bar.label)}
                            />
                          ))}
                        </View>
                      ) : null}
                      {index === rows.length - 1 && entry.limits.error ? (
                        <Text style={styles.errorText} numberOfLines={2}>
                          {entry.limits.error}
                        </Text>
                      ) : null}
                    </View>
                    <View style={styles.rowTrailing} />
                  </View>
                </View>
              ))}
            </View>
          </View>
        )
      })}
    </>
  )
}

const styles = themedStyleSheet(() => ({
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
  // Indent countdown past window label to align with track.
  usageResetText: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    marginLeft: 22 + spacing.xs
  },
  section: {
    marginBottom: spacing.xl
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm
  },
  sectionHeading: {
    fontSize: typography.metaSize,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  card: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    overflow: 'hidden'
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowMain: {
    flex: 1,
    gap: 4
  },
  rowTrailing: {
    width: 24,
    marginLeft: spacing.sm
  },
  rowTitle: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  usageRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginTop: 4
  },
  errorText: {
    fontSize: typography.metaSize,
    color: colors.statusRed
  }
}))
