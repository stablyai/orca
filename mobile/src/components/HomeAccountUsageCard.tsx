import { View, Text, Pressable, StyleSheet } from 'react-native'
import { Gauge } from 'lucide-react-native'
import { colors, spacing, radii } from '../theme/mobile-theme'
import { ClaudeIcon, OpenAIIcon } from './AgentIcons'
import {
  type AccountsSnapshot,
  type UsageProviderKey,
  USAGE_PROVIDERS,
  getActiveProviderRateLimits,
  getProviderUsageWindows,
  getUsageBarState,
  hasRenderableUsage,
  UsageBar,
  UsageWindowBars
} from './AccountUsage'

// Why: one host's Account-usage card on the home screen. Extracted from
// app/index.tsx to keep that screen under the max-lines ratchet and to house
// the multi-provider rendering (managed Claude/Codex switch summary + the
// display-only providers gated by the per-device visibility filter).
export function HomeAccountUsageCard({
  snapshot,
  visibleProviders,
  showHostName,
  hostName,
  now,
  onPress
}: {
  snapshot: AccountsSnapshot
  visibleProviders: Set<UsageProviderKey>
  showHostName: boolean
  hostName: string
  now: number
  onPress: () => void
}) {
  const claudeActiveId = snapshot.claude.activeAccountId
  const claudeActive = snapshot.claude.accounts.find((a) => a.id === claudeActiveId) ?? null
  const codexActiveId = snapshot.codex.activeAccountId
  const codexActive = snapshot.codex.accounts.find((a) => a.id === codexActiveId) ?? null

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={onPress}
    >
      {showHostName ? (
        <Text style={styles.hostLabel} numberOfLines={1}>
          {hostName}
        </Text>
      ) : null}
      {USAGE_PROVIDERS.filter((p) => visibleProviders.has(p.id)).map((descriptor) => {
        const limits = getActiveProviderRateLimits(snapshot, descriptor.id)
        if (!hasRenderableUsage(snapshot, descriptor.id)) {
          return null
        }
        const active =
          descriptor.id === 'claude' ? claudeActive : descriptor.id === 'codex' ? codexActive : null
        const sessionBar = getUsageBarState(limits, 'session')
        const weeklyBar = getUsageBarState(limits, 'weekly')
        return (
          <View key={descriptor.id} style={styles.row}>
            <View style={styles.icon}>
              {descriptor.id === 'claude' ? (
                <ClaudeIcon size={18} />
              ) : descriptor.id === 'codex' ? (
                <OpenAIIcon size={18} color={colors.textPrimary} />
              ) : (
                <Gauge size={18} color={colors.textSecondary} />
              )}
            </View>
            <View style={styles.info}>
              <Text style={styles.email} numberOfLines={1}>
                {descriptor.managed ? (active?.email ?? 'System default') : descriptor.label}
              </Text>
              {descriptor.managed ? (
                <View style={styles.bars}>
                  <UsageBar
                    label="5h"
                    usedPercent={sessionBar.usedPercent}
                    unavailable={sessionBar.unavailable}
                    loading={sessionBar.loading}
                  />
                  <UsageBar
                    label="7d"
                    usedPercent={weeklyBar.usedPercent}
                    unavailable={weeklyBar.unavailable}
                    loading={weeklyBar.loading}
                  />
                </View>
              ) : (
                <View style={styles.windows}>
                  <UsageWindowBars
                    windows={getProviderUsageWindows(limits)}
                    fetching={limits?.status === 'fetching'}
                    now={now}
                  />
                </View>
              )}
            </View>
          </View>
        )
      })}
    </Pressable>
  )
}

// Mirrors the styles this card used when it lived inline in app/index.tsx, so
// the visual result is unchanged by the extraction.
const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    gap: spacing.sm,
    marginBottom: spacing.sm
  },
  cardPressed: {
    backgroundColor: colors.bgRaised
  },
  hostLabel: {
    fontSize: 11,
    color: colors.textMuted,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.4
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2
  },
  icon: {
    width: 32,
    height: 32,
    borderRadius: 9,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  info: {
    flex: 1,
    minWidth: 0,
    gap: 2
  },
  email: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary
  },
  bars: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: 4
  },
  windows: {
    marginTop: 4,
    gap: 4
  }
})
