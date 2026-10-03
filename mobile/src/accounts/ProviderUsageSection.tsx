import { View, Text } from 'react-native'
import { styles } from './mobile-accounts-screen-styles'
import {
  getUsageBarState,
  getWindowResetLabel,
  UsageBar,
  type UsageWindowKey
} from '../components/AccountUsage'
import type { ExtraProviderUsage } from '../components/extra-provider-usage'

const WINDOW_LABELS: Record<UsageWindowKey, string> = {
  session: '5h',
  weekly: '7d',
  monthly: '30d'
}

// Why: pairs match the two-bar rows of the Claude/Codex sections.
function chunkPairs<T>(items: T[]): T[][] {
  const rows: T[][] = []
  for (let i = 0; i < items.length; i += 2) {
    rows.push(items.slice(i, i + 2))
  }
  return rows
}

// Read-only: desktop manages accounts only for Claude and Codex, so there is
// no account to switch here — just the usage the host already polls.
export function ProviderUsageSection({ usage, now }: { usage: ExtraProviderUsage; now: number }) {
  const { title, limits, windows } = usage
  const fetching = limits.status === 'fetching' || limits.status === 'idle'
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionHeading}>{title}</Text>
      </View>
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowMain}>
            {windows.length === 0 ? (
              <Text style={styles.rowSubtitle}>
                {fetching ? 'Loading usage…' : 'No usage reported'}
              </Text>
            ) : (
              chunkPairs(windows).map((pair) => (
                <View key={pair.join('-')} style={styles.usageRow}>
                  {pair.map((windowKey) => {
                    const bar = getUsageBarState(limits, windowKey)
                    return (
                      <UsageBar
                        key={windowKey}
                        label={WINDOW_LABELS[windowKey]}
                        usedPercent={bar.usedPercent}
                        unavailable={bar.unavailable}
                        loading={bar.loading}
                        resetText={getWindowResetLabel(limits, windowKey, now)}
                      />
                    )
                  })}
                  {/* Why: a lone bar keeps the same width as a paired one. */}
                  {pair.length === 1 ? <View style={styles.usageRowFiller} /> : null}
                </View>
              ))
            )}
            {limits.error ? (
              <Text style={styles.errorText} numberOfLines={2}>
                {limits.error}
              </Text>
            ) : null}
          </View>
        </View>
      </View>
    </View>
  )
}
