import { StyleSheet, Text, View } from 'react-native'
import { Coins } from 'lucide-react-native'
import type { AccountsSnapshot } from './accounts-snapshot'
import { getDeepSeekBalanceState } from './deepseek-balance-state'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export function DeepSeekBalanceCard({
  snapshot,
  compact = false
}: {
  snapshot: AccountsSnapshot
  compact?: boolean
}) {
  const state = getDeepSeekBalanceState(snapshot)
  if (!state) {
    return null
  }
  return (
    <View style={compact ? styles.compact : styles.card} accessibilityLiveRegion="polite">
      <View style={styles.headingRow}>
        <Coins size={18} color={colors.textSecondary} />
        <Text style={styles.heading}>DeepSeek balance</Text>
      </View>
      {state.balance?.balance_infos.map((row) => (
        <View key={row.currency} style={styles.currency}>
          <View style={styles.amountRow}>
            {!compact ? <Text style={styles.label}>Balance</Text> : null}
            <Text selectable style={styles.amount}>
              {row.currency} {row.total_balance}
            </Text>
          </View>
          {!compact ? (
            <>
              <View style={styles.amountRow}>
                <Text style={styles.label}>Granted</Text>
                <Text selectable style={styles.detailAmount}>
                  {row.currency} {row.granted_balance}
                </Text>
              </View>
              <View style={styles.amountRow}>
                <Text style={styles.label}>Topped up</Text>
                <Text selectable style={styles.detailAmount}>
                  {row.currency} {row.topped_up_balance}
                </Text>
              </View>
            </>
          ) : null}
        </View>
      ))}
      {state.messages.map((message) => (
        <Text key={message} style={styles.notice}>
          {message}
        </Text>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: spacing.lg,
    marginBottom: spacing.xl,
    gap: spacing.md
  },
  compact: { gap: spacing.sm },
  headingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  heading: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  currency: { gap: spacing.xs },
  amountRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  label: { color: colors.textSecondary, fontSize: typography.metaSize },
  amount: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontFamily: typography.monoFamily,
    flexShrink: 1,
    textAlign: 'right'
  },
  detailAmount: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily,
    flexShrink: 1,
    textAlign: 'right'
  },
  notice: { color: colors.textMuted, fontSize: typography.metaSize }
})
