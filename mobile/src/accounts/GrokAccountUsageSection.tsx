import { Text, View } from 'react-native'
import type { AccountsSnapshot } from '../components/accounts-snapshot'
import { UsageBar } from '../components/AccountUsage'
import { getGrokAccountUsage, getGrokUsageBarModel } from '../components/grok-account-usage'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { styles } from './mobile-accounts-screen-styles'

// Why: Grok is one CLI session on the paired desktop. There is no account
// list to switch, so this section is read-only.
export function GrokAccountUsageSection(props: { snapshot: AccountsSnapshot; now: number }) {
  const usage = getGrokAccountUsage(props.snapshot)
  if (!usage) {
    return null
  }
  const meter = getGrokUsageBarModel(usage, props.now)
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <MobileAgentIcon agentId="grok" size={14} />
        <Text style={styles.sectionHeading}>Grok</Text>
      </View>
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {usage.label}
            </Text>
            <View style={styles.usageRow}>
              <UsageBar
                label={meter.windowLabel}
                labelWidth={meter.labelWidth}
                usedPercent={meter.bar.usedPercent}
                unavailable={meter.bar.unavailable}
                loading={meter.bar.loading}
                resetText={meter.resetText}
              />
            </View>
            {usage.limits?.error ? (
              <Text style={styles.errorText} numberOfLines={2}>
                {usage.limits.error}
              </Text>
            ) : null}
          </View>
          <View style={styles.rowTrailing} />
        </View>
      </View>
    </View>
  )
}
