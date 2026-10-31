import { Text, View } from 'react-native'
import { formatResetCountdown } from '../../../src/shared/rate-limit-reset-format'
import {
  type ProviderRateLimits,
  getUsageBarState,
  getWindowResetLabel,
  hasActiveProviderUsage,
  UsageBar
} from '../components/AccountUsage'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
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
    <View>
      <SectionHeader
        title={t('accounts.screen.antigravity', 'Antigravity')}
        icon={<MobileAgentIcon agentId="antigravity" size={14} />}
      />
      <ListGroup style={styles.group}>
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
                <ListRow
                  key={bucketKey}
                  title={bucket.name}
                  detail={
                    <>
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
                    </>
                  }
                />
              )
            })
          })()
        ) : (
          <ListRow
            key="default"
            title={t('accounts.screen.default', 'System default')}
            subtitle={t('accounts.screen.agentLogin', "Use the agent's own login")}
            detail={
              <>
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
              </>
            }
          />
        )}
      </ListGroup>
    </View>
  )
}
