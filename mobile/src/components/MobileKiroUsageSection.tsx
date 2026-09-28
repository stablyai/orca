import { View, Text } from 'react-native'
import { styles } from '../accounts/mobile-accounts-screen-styles'
import { MobileAgentIcon } from './MobileAgentIcon'
import {
  type AccountsSnapshot,
  getKiroProviderRateLimits,
  getUsageBarState,
  getWindowResetLabel,
  hasActiveProviderUsage,
  UsageBar
} from './AccountUsage'

// Why: Kiro is CLI/SSO auth with no account switching — a single card showing
// the monthly plan meter, plan tier, and used/limit credits. Mirrors the
// desktop roster's Kiro provider row. Kept in its own file so the accounts
// screen stays under the max-lines cap.
export function MobileKiroUsageSection({
  snapshot,
  now
}: {
  snapshot: AccountsSnapshot
  now: number
}): React.JSX.Element | null {
  const kiro = getKiroProviderRateLimits(snapshot)
  if (!hasActiveProviderUsage(kiro)) {
    return null
  }
  const isFetching = kiro?.status === 'fetching'
  const monthlyBar = getUsageBarState(kiro, 'monthly', isFetching)
  const credits = kiro?.kiroCredits ?? null
  const round = (n: number): number => Number(n.toFixed(2))
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <MobileAgentIcon agentId="kiro" size={14} />
        <Text style={styles.sectionHeading}>Kiro</Text>
      </View>
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={styles.rowTitle}>{kiro?.planType ?? 'Kiro plan'}</Text>
            {credits ? (
              <Text style={styles.rowSubtitle}>
                {round(credits.used)} / {round(credits.limit)} credits
              </Text>
            ) : (
              <Text style={styles.rowSubtitle}>Monthly plan usage</Text>
            )}
            <View style={styles.usageRow}>
              <UsageBar
                label="mo"
                usedPercent={monthlyBar.usedPercent}
                unavailable={monthlyBar.unavailable}
                loading={monthlyBar.loading}
                resetText={getWindowResetLabel(kiro, 'monthly', now)}
              />
            </View>
            {kiro?.error ? (
              <Text style={styles.errorText} numberOfLines={1}>
                {kiro.error}
              </Text>
            ) : null}
          </View>
        </View>
      </View>
    </View>
  )
}
