import { Wallet } from 'lucide-react-native'
import { Text, View } from 'react-native'
import type { AccountsSnapshot } from '../components/accounts-snapshot'
import { getDeepSeekAccountUsage } from '../components/deepseek-account-usage'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-accounts-screen-styles'

export function DeepSeekAccountUsageSection({ snapshot }: { snapshot: AccountsSnapshot }) {
  const usage = getDeepSeekAccountUsage(snapshot)
  if (!usage) {
    return null
  }

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Wallet size={14} color={colors.textMuted} />
        <Text style={styles.sectionHeading}>DeepSeek API</Text>
      </View>
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={styles.rowTitle}>Balance</Text>
            <Text style={styles.rowSubtitle} numberOfLines={1}>
              {usage.balanceLabel ?? usage.statusLabel}
            </Text>
            <Text style={styles.rowSubtitle}>Read from the connected host</Text>
            {usage.balanceLabel && usage.status !== 'available' ? (
              <Text style={styles.errorText}>{usage.statusLabel}</Text>
            ) : null}
          </View>
        </View>
      </View>
    </View>
  )
}
