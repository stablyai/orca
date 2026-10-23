import { View } from 'react-native'
import {
  type ProviderRateLimits,
  getUsageBarState,
  getWindowResetLabel,
  UsageBar
} from '../components/AccountUsage'
import { styles } from './mobile-accounts-screen-styles'

export function MobileAccountUsageWindows({
  limits,
  now,
  isFetching
}: {
  limits: ProviderRateLimits | null
  now: number
  isFetching?: boolean
}) {
  const sessionBar = getUsageBarState(limits, 'session', isFetching)
  const weeklyBar = getUsageBarState(limits, 'weekly', isFetching)
  return (
    <View style={styles.usageRow}>
      <UsageBar
        label="5h"
        usedPercent={sessionBar.usedPercent}
        unavailable={sessionBar.unavailable}
        loading={sessionBar.loading}
        resetText={getWindowResetLabel(limits, 'session', now)}
      />
      <UsageBar
        label="7d"
        usedPercent={weeklyBar.usedPercent}
        unavailable={weeklyBar.unavailable}
        loading={weeklyBar.loading}
        resetText={getWindowResetLabel(limits, 'weekly', now)}
      />
    </View>
  )
}
