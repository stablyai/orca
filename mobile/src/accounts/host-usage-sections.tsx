import { Text, View } from 'react-native'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import {
  type AccountsSnapshot,
  getHostProviderRateLimits,
  getUsageBarState,
  getWindowResetLabel,
  hasActiveProviderUsage,
  UsageBar
} from '../components/AccountUsage'
import { CodexResetCreditAction } from '../components/CodexResetCreditAction'
import { getGrokResetCreditSummary } from '../components/grok-reset-credit'
import { useGrokResetCreditAction } from '../components/use-grok-reset-credit-action'
import type { RpcClient } from '../transport/rpc-client'
import { styles } from './mobile-accounts-screen-styles'

export function HostUsageSections({
  snapshot,
  now,
  connected,
  busy,
  client,
  hostId,
  onSnapshot
}: {
  snapshot: AccountsSnapshot
  now: number
  connected: boolean
  busy: boolean
  client: RpcClient | null
  hostId: string | undefined
  onSnapshot: (snapshot: AccountsSnapshot) => void
}): React.JSX.Element | null {
  const { supported, resetting, confirmReset } = useGrokResetCreditAction({
    client,
    connected,
    hostId,
    snapshot,
    accountMutationBusy: busy,
    onSnapshot
  })
  const usage = getHostProviderRateLimits(snapshot, 'grok')
  if (!hasActiveProviderUsage(usage)) {
    return null
  }
  const weeklyBar = getUsageBarState(usage, 'weekly')
  const resetCredit = getGrokResetCreditSummary(usage, now)
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <MobileAgentIcon agentId="grok" size={14} />
        <Text style={styles.sectionHeading}>Grok</Text>
      </View>
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={styles.rowTitle}>Host CLI login</Text>
            <Text style={styles.rowSubtitle} numberOfLines={1}>
              {usage?.usageMetadata?.authProvenance ?? 'Uses grok login on the host'}
            </Text>
            <View style={styles.usageRow}>
              <UsageBar
                label="7d"
                usedPercent={weeklyBar.usedPercent}
                unavailable={weeklyBar.unavailable}
                loading={weeklyBar.loading}
                resetText={getWindowResetLabel(usage, 'weekly', now)}
              />
            </View>
          </View>
        </View>
        {resetCredit && supported && connected ? (
          <CodexResetCreditAction
            summary={resetCredit}
            productLabel="Grok"
            scopeLabel="the host Grok login"
            busy={resetting}
            disabled={resetting || busy || !connected}
            onPress={confirmReset}
          />
        ) : null}
      </View>
    </View>
  )
}
