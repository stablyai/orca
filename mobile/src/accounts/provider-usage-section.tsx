import { Text, View } from 'react-native'
import {
  collectProviderUsageMeters,
  getGrokUsageWindowKey,
  getMeterResetLabel,
  hasRenderableProviderUsage,
  providerUsagePlaceholder,
  readUsageAuthProvenance,
  type AccountsSnapshot,
  type MobileUsageProviderId,
  type UsageMeter
} from '../components/account-usage-state'
import { UsageBar } from '../components/AccountUsage'
import { MiniMaxIcon, OpenCodeGoIcon } from '../components/AgentIcons'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { styles } from './mobile-accounts-screen-styles'

const PROVIDER_COPY = {
  gemini: { headingKey: 'accounts.screen.gemini', heading: 'Gemini' },
  opencodeGo: { headingKey: 'accounts.screen.opencodeGo', heading: 'OpenCode Go' },
  minimax: { headingKey: 'accounts.screen.minimax', heading: 'MiniMax' },
  grok: { headingKey: 'accounts.screen.grok', heading: 'Grok' },
  cursor: { headingKey: 'accounts.screen.cursor', heading: 'Cursor' },
  zcode: { headingKey: 'accounts.screen.zcodePlan', heading: 'GLM Coding Plan' }
} as const

export function ProviderUsageSection({
  provider,
  snapshot,
  now
}: {
  provider: Exclude<MobileUsageProviderId, 'antigravity'>
  snapshot: AccountsSnapshot
  now: number
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  if (!hasRenderableProviderUsage(snapshot, provider)) {
    return null
  }
  const limits = snapshot.rateLimits[provider] ?? null
  const collected = collectProviderUsageMeters(provider, limits)
  const meters = collected.length > 0 ? collected : [providerUsagePlaceholder(provider, limits)]
  const copy = PROVIDER_COPY[provider]
  const provenance = readUsageAuthProvenance(limits)
  const grokWindow = provider === 'grok' ? getGrokUsageWindowKey(limits) : null
  const grokHasWindow = grokWindow != null && limits?.[grokWindow] != null
  const headline =
    provider !== 'grok'
      ? null
      : !grokHasWindow
        ? t('accounts.screen.grokUsage', 'Usage')
        : grokWindow === 'monthly'
          ? t('accounts.screen.grokMonthlyUsage', 'Monthly usage')
          : t('accounts.screen.grokWeeklyCredits', 'Weekly credits')
  const subtitle =
    provenance ??
    (provider === 'grok' && grokHasWindow
      ? grokWindow === 'monthly'
        ? t('accounts.screen.grokMonthlyHint', 'Included monthly usage for this Grok account.')
        : t(
            'accounts.screen.grokWeeklyHint',
            'Weekly credits from the Grok CLI sign-in on this host.'
          )
      : null)

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <ProviderIcon provider={provider} />
        <Text style={styles.sectionHeading}>{t(copy.headingKey, copy.heading)}</Text>
      </View>
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowMain}>
            {headline ? <Text style={styles.rowTitle}>{headline}</Text> : null}
            {subtitle ? <Text style={styles.rowSubtitle}>{subtitle}</Text> : null}
            <UsageMeterList meters={meters} now={now} />
            {limits?.error ? (
              <Text style={styles.errorText} numberOfLines={3}>
                {limits.error}
              </Text>
            ) : null}
          </View>
        </View>
      </View>
    </View>
  )
}

export function UsageMeterList({ meters, now }: { meters: UsageMeter[]; now: number }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View style={styles.usageStack}>
      {meters.map((meter) => {
        const title = meterTitle(t, meter.title)
        return (
          <View key={meter.key}>
            {title ? (
              <Text style={styles.rowSubtitle} numberOfLines={1}>
                {title}
              </Text>
            ) : null}
            <UsageBar
              label={meter.chip}
              labelWidth={meter.chip ? 22 : 0}
              usedPercent={meter.usedPercent}
              unavailable={meter.unavailable}
              loading={meter.loading}
              resetText={getMeterResetLabel(meter, now)}
            />
          </View>
        )
      })}
    </View>
  )
}

function meterTitle(
  t: (key: string, fallback: string) => string,
  title: string | null
): string | null {
  if (title === 'Plan') {
    return t('accounts.screen.planTotal', 'Plan')
  }
  if (title === 'MCP monthly') {
    return t('accounts.screen.mcpMonthly', 'MCP monthly')
  }
  if (title === 'Fable') {
    return t('accounts.screen.fable', 'Fable')
  }
  return title
}

function ProviderIcon({ provider }: { provider: Exclude<MobileUsageProviderId, 'antigravity'> }) {
  if (provider === 'opencodeGo') {
    return <OpenCodeGoIcon size={14} />
  }
  if (provider === 'minimax') {
    return <MiniMaxIcon size={14} />
  }
  return <MobileAgentIcon agentId={provider} size={14} />
}
