import { View, Text, StyleSheet, ActivityIndicator } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'

// Why: keep these shapes in lockstep with src/shared/types.ts and
// src/shared/rate-limit-types.ts. We don't import from desktop here because
// the mobile bundle must not pull in Electron-coupled type files.
export type RateLimitWindow = {
  usedPercent: number
  windowMinutes: number
  resetsAt: number | null
  resetDescription: string | null
}

export type ProviderRateLimits = {
  provider: 'claude' | 'codex' | 'gemini' | 'opencode-go'
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
  monthly?: RateLimitWindow | null
  updatedAt: number
  error: string | null
  status: 'idle' | 'fetching' | 'ok' | 'error' | 'unavailable'
}

export type InactiveAccountUsage = {
  accountId: string
  claude: ProviderRateLimits | null
  updatedAt: number
  isFetching: boolean
}

export type ClaudeAccountSummary = {
  id: string
  email: string
  organizationName?: string | null
}

export type CodexAccountSummary = {
  id: string
  email: string
  workspaceLabel?: string | null
}

export type AccountsSnapshot = {
  claude: { accounts: ClaudeAccountSummary[]; activeAccountId: string | null }
  codex: { accounts: CodexAccountSummary[]; activeAccountId: string | null }
  rateLimits: {
    claude: ProviderRateLimits | null
    codex: ProviderRateLimits | null
    inactiveClaudeAccounts: InactiveAccountUsage[]
    inactiveCodexAccounts: InactiveAccountUsage[]
  }
}

export type ProviderKey = 'claude' | 'codex'

export function getActiveProviderRateLimits(
  snapshot: AccountsSnapshot,
  provider: ProviderKey
): ProviderRateLimits | null {
  return provider === 'claude' ? snapshot.rateLimits.claude : snapshot.rateLimits.codex
}

export function getInactiveProviderUsage(
  snapshot: AccountsSnapshot,
  provider: ProviderKey,
  accountId: string
): InactiveAccountUsage | null {
  const list =
    provider === 'claude'
      ? snapshot.rateLimits.inactiveClaudeAccounts
      : snapshot.rateLimits.inactiveCodexAccounts
  return list.find((u) => u.accountId === accountId) ?? null
}

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
