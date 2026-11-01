import { Text, View } from 'react-native'
import { formatResetCountdown } from '../../../src/shared/rate-limit-reset-format'
import {
  type ProviderRateLimits,
  getUsageBarState,
  getWindowResetLabel,
  hasActiveProviderUsage,
  UsageBar
} from '../components/AccountUsage'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { styles } from './mobile-accounts-screen-styles'

export function MobileAntigravityUsageSection({
  limits,
  now
}: {
  limits: ProviderRateLimits | null
  now: number
}) {
  const t = useMobileTranslation()
  if (!hasActiveProviderUsage(limits)) {
    return null
  }

  const buckets = limits?.buckets
  const sessionBar = getUsageBarState(limits, 'session')
  const weeklyBar = getUsageBarState(limits, 'weekly')

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <MobileAgentIcon agentId="antigravity" size={14} />
        <Text style={styles.sectionHeading}>{t('accounts.screen.antigravity', 'Antigravity')}</Text>
      </View>
      <View style={styles.card}>
        {buckets && buckets.length > 0 ? (
          (() => {
            const usedBucketKeys = new Set<string>()
            return buckets.map((bucket, index) => {
              const baseKey = bucket.id ?? `${bucket.name}-${bucket.windowMinutes}`
              let bucketKey = baseKey
              let suffix = 1
              while (usedBucketKeys.has(bucketKey)) {
                bucketKey = `${baseKey}-${suffix}`
                suffix += 1
              }
              usedBucketKeys.add(bucketKey)
              const label =
                bucket.windowMinutes === 10080
                  ? t('accounts.screen.weeklyWindow', '7d')
                  : bucket.windowMinutes === 300
                    ? t('accounts.screen.sessionWindow', '5h')
                    : ''
              return (
                <View key={bucketKey}>
                  {index > 0 ? <View style={styles.separator} /> : null}
                  <View style={styles.row}>
                    <View style={styles.rowMain}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {bucket.name}
                      </Text>
                      <View style={styles.usageRow}>
                        <UsageBar
                          label={label}
                          usedPercent={bucket.usedPercent}
                          unavailable={false}
                          resetText={
                            bucket.resetsAt != null
                              ? formatResetCountdown(bucket.resetsAt - now)
                              : null
                          }
                        />
                      </View>
                      {index === buckets.length - 1 && limits?.error ? (
                        <Text style={styles.errorText} numberOfLines={1}>
                          {limits.error}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                </View>
              )
            })
          })()
        ) : (
          <View style={styles.row}>
            <View style={styles.rowMain}>
              <Text style={styles.rowTitle}>{t('accounts.screen.default', 'System default')}</Text>
              <Text style={styles.rowSubtitle}>
                {t('accounts.screen.agentLogin', "Use the agent's own login")}
              </Text>
              <View style={styles.usageRow}>
                <UsageBar
                  label={t('accounts.screen.sessionWindow', '5h')}
                  usedPercent={sessionBar.usedPercent}
                  unavailable={sessionBar.unavailable}
                  loading={sessionBar.loading}
                  resetText={getWindowResetLabel(limits, 'session', now)}
                />
                <UsageBar
                  label={t('accounts.screen.weeklyWindow', '7d')}
                  usedPercent={weeklyBar.usedPercent}
                  unavailable={weeklyBar.unavailable}
                  loading={weeklyBar.loading}
                  resetText={getWindowResetLabel(limits, 'weekly', now)}
                />
              </View>
              {limits?.error ? (
                <Text style={styles.errorText} numberOfLines={1}>
                  {limits.error}
                </Text>
              ) : null}
            </View>
          </View>
        )}
      </View>
    </View>
  )
}
