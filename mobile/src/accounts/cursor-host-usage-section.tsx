import { Text, View } from 'react-native'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import {
  type AccountsSnapshot,
  getBucketResetLabel,
  getBucketUsageBarState,
  getHostProviderRateLimits,
  hasActiveProviderUsage,
  UsageBar
} from '../components/AccountUsage'
import { styles } from './mobile-accounts-screen-styles'

export function CursorHostUsageSection({
  snapshot,
  now
}: {
  snapshot: AccountsSnapshot
  now: number
}): React.JSX.Element | null {
  const usage = getHostProviderRateLimits(snapshot, 'cursor')
  if (!hasActiveProviderUsage(usage)) {
    return null
  }
  const email = usage?.usageMetadata?.accountEmail ?? null
  const subscriptionStatus = usage?.usageMetadata?.subscriptionStatus ?? null
  const planLabel = usage?.planType ?? null
  const buckets = usage?.buckets ?? []

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <MobileAgentIcon agentId="cursor" size={14} />
        <Text style={styles.sectionHeading}>Cursor</Text>
      </View>
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {email ?? 'Host Cursor login'}
            </Text>
            {planLabel || subscriptionStatus ? (
              <Text style={styles.rowSubtitle} numberOfLines={1}>
                {[planLabel, subscriptionStatus].filter(Boolean).join(' · ')}
              </Text>
            ) : (
              <Text style={styles.rowSubtitle}>Uses Cursor on the host</Text>
            )}
            {buckets.map((bucket) => {
              const bar = getBucketUsageBarState(usage, bucket.name)
              return (
                <View key={bucket.name} style={styles.usageRow}>
                  <UsageBar
                    label={bucket.name}
                    labelWidth={92}
                    usedPercent={bar.usedPercent}
                    unavailable={bar.unavailable}
                    loading={bar.loading}
                    resetText={
                      getBucketResetLabel(usage, bucket.name, now) ??
                      (bucket.resetDescription ? `Resets ${bucket.resetDescription}` : null)
                    }
                  />
                </View>
              )
            })}
          </View>
        </View>
      </View>
    </View>
  )
}
