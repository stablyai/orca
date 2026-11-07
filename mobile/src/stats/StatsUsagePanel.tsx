import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, View } from 'react-native'
import { RefreshCw } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { RpcClient } from '../transport/rpc-client'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  BlockLabel,
  BreakdownSection,
  CardDivider,
  DailyBars,
  formatSessionTime,
  MetricStrip,
  Notice,
  Segmented,
  TokenMix,
  UsageRow,
  UsageSection
} from './stats-usage-parts'
import { fetchUsageReport } from './usage-snapshot-operations'
import {
  buildUsageOverview,
  formatCost,
  formatTokens,
  USAGE_PROVIDER_LABELS,
  USAGE_PROVIDERS,
  type UsageProviderId,
  type UsageProviderReport,
  type UsageRange,
  type UsageScope
} from './usage-report-model'

type UsageTab = 'overview' | UsageProviderId

const RANGE_IDS: UsageRange[] = ['7d', '30d', '90d', 'all']
const SCOPE_IDS: UsageScope[] = ['orca', 'all']

// Desktop overview hues, one per agent so the stacked daily bars stay readable.
// Muse reads the live theme purple, so this is a function rather than a module-scope constant.
function providerColor(id: UsageProviderId): string {
  return { claude: '#d97757', codex: '#38bdf8', opencode: '#34d399', muse: colors.statusPurple }[id]
}

type ReportState =
  | { status: 'loading' }
  | { status: 'unsupported' }
  | { status: 'error' }
  | { status: 'ok'; providers: Record<UsageProviderId, UsageProviderReport> }

/** Mobile port of the desktop Settings → Stats & Usage pane, read from one paired desktop. */
export function StatsUsagePanel(props: { client: RpcClient | null }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { client } = props
  const [scope, setScope] = useState<UsageScope>('orca')
  const [range, setRange] = useState<UsageRange>('30d')
  const [tab, setTab] = useState<UsageTab>('overview')
  const [report, setReport] = useState<ReportState>({ status: 'loading' })
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (!client) {
      return
    }
    let stale = false
    setReport({ status: 'loading' })
    fetchUsageReport(client, scope, range)
      .then((result) => {
        if (!stale) {
          setReport(result)
        }
      })
      .catch(() => {
        if (!stale) {
          setReport({ status: 'error' })
        }
      })
    return () => {
      stale = true
    }
  }, [client, scope, range, reloadKey])

  const reload = useCallback(() => setReloadKey((key) => key + 1), [])
  const showFilters = report.status !== 'unsupported'
  const tabs = [
    { id: 'overview', label: t('statsUsage.tabs.overview', 'All agents') },
    ...USAGE_PROVIDERS.map((id) => ({ id, label: USAGE_PROVIDER_LABELS[id] }))
  ]
  const ranges = RANGE_IDS.map((id) => ({
    id,
    label: id === 'all' ? t('statsUsage.ranges.all', 'All') : id
  }))
  const scopes = SCOPE_IDS.map((id) => ({
    id,
    label:
      id === 'orca'
        ? t('statsUsage.scopes.orca', 'Orca only')
        : t('statsUsage.scopes.all', 'All sessions')
  }))

  return (
    <View>
      <UsageSection
        title={t('statsUsage.usageHeading', 'Usage')}
        first
        accessory={
          client ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('statsUsage.refresh', 'Refresh usage')}
              hitSlop={8}
              onPress={reload}
            >
              <RefreshCw size={14} color={colors.textMuted} />
            </Pressable>
          ) : undefined
        }
      >
        {!client ? (
          <Notice>{t('statsUsage.connectDesktop', 'Connect to a desktop to see usage.')}</Notice>
        ) : (
          <>
            {showFilters ? (
              <>
                <Segmented items={tabs} selected={tab} onSelect={(id) => setTab(id as UsageTab)} />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <View style={{ flex: 2 }}>
                    <Segmented
                      items={scopes}
                      selected={scope}
                      onSelect={(id) => setScope(id as UsageScope)}
                    />
                  </View>
                  <View style={{ flex: 3 }}>
                    <Segmented
                      items={ranges}
                      selected={range}
                      onSelect={(id) => setRange(id as UsageRange)}
                    />
                  </View>
                </View>
                <CardDivider />
              </>
            ) : null}
            {report.status === 'loading' ? (
              <ActivityIndicator color={colors.textMuted} />
            ) : report.status === 'unsupported' ? (
              <Notice>
                {t('statsUsage.updateDesktop', 'Update Orca on your computer to see usage')}
              </Notice>
            ) : report.status === 'error' ? (
              <Notice>
                {t('statsUsage.loadFailed', 'Could not load usage. Tap refresh to retry.')}
              </Notice>
            ) : tab === 'overview' ? (
              <OverviewBody providers={report.providers} />
            ) : (
              <ProviderBody report={report.providers[tab]} />
            )}
          </>
        )}
      </UsageSection>
      {report.status === 'ok' && client ? (
        tab === 'overview' ? (
          <AgentList providers={report.providers} onOpen={setTab} />
        ) : (
          <ProviderLists report={report.providers[tab]} />
        )
      ) : null}
    </View>
  )
}

function OverviewBody(props: { providers: Record<UsageProviderId, UsageProviderReport> }) {
  const t = useMobileTranslation()
  const overview = useMemo(() => buildUsageOverview(props.providers), [props.providers])
  if (!overview.hasAnyEnabled) {
    return (
      <Notice>
        {t(
          'statsUsage.trackingOff',
          "Usage tracking is off. Turn it on in the desktop's Settings → Stats & Usage."
        )}
      </Notice>
    )
  }
  return (
    <>
      <MetricStrip
        items={[
          {
            label: t('statsUsage.metrics.tokens', 'Tokens'),
            value: formatTokens(overview.totalTokens)
          },
          { label: t('statsUsage.metrics.cost', 'Est. cost'), value: formatCost(overview.costUsd) },
          {
            label: t('statsUsage.metrics.sessions', 'Sessions'),
            value: overview.sessions.toLocaleString()
          },
          {
            label: t('statsUsage.metrics.activeDays', 'Active days'),
            value: overview.activeDays.toLocaleString()
          }
        ]}
      />
      <CardDivider />
      <BlockLabel>{t('statsUsage.dailyTokens', 'Daily tokens')}</BlockLabel>
      <DailyBars
        days={overview.daily.map((entry) => ({
          day: entry.day,
          segments: USAGE_PROVIDERS.map((id) => ({
            color: providerColor(id),
            value: entry.byProvider[id]
          }))
        }))}
      />
      <CardDivider />
      <TokenMix
        input={overview.newInputTokens}
        output={overview.outputTokens}
        cache={overview.cacheTokens}
      />
    </>
  )
}

function ProviderBody(props: { report: UsageProviderReport }) {
  const t = useMobileTranslation()
  const { report } = props
  const label = USAGE_PROVIDER_LABELS[report.id]
  if (!report.enabled) {
    return (
      <Notice>
        {t(
          'statsUsage.providerTrackingOff',
          "{{provider}} tracking is off. Turn it on in the desktop's Settings → Stats & Usage.",
          { provider: label }
        )}
      </Notice>
    )
  }
  if (!report.hasData) {
    return (
      <Notice>
        {report.isScanning
          ? t('statsUsage.scanning', 'Scanning {{provider}} sessions…', { provider: label })
          : t('statsUsage.noUsageYet', 'No {{provider}} usage found yet.', { provider: label })}
      </Notice>
    )
  }
  return (
    <>
      <MetricStrip
        items={[
          {
            label: t('statsUsage.metrics.tokens', 'Tokens'),
            value: formatTokens(report.totalTokens)
          },
          { label: t('statsUsage.metrics.cost', 'Est. cost'), value: formatCost(report.costUsd) },
          {
            label: t('statsUsage.metrics.sessions', 'Sessions'),
            value: report.sessions.toLocaleString()
          },
          {
            label:
              report.activityLabel === 'turns'
                ? t('statsUsage.metrics.turns', 'Turns')
                : t('statsUsage.metrics.events', 'Events'),
            value: report.activityCount.toLocaleString()
          }
        ]}
      />
      <CardDivider />
      <BlockLabel>{t('statsUsage.dailyTokens', 'Daily tokens')}</BlockLabel>
      <DailyBars
        days={report.daily.map((entry) => ({
          day: entry.day,
          segments: [{ color: providerColor(report.id), value: entry.totalTokens }]
        }))}
      />
      <CardDivider />
      <TokenMix
        input={report.newInputTokens}
        output={report.outputTokens}
        cache={report.cacheTokens}
      />
    </>
  )
}

function AgentList(props: {
  providers: Record<UsageProviderId, UsageProviderReport>
  onOpen: (id: UsageProviderId) => void
}) {
  const t = useMobileTranslation()
  const reports = USAGE_PROVIDERS.map((id) => props.providers[id])
  if (!reports.some((report) => report.enabled)) {
    return null
  }
  const max = Math.max(1, ...reports.map((report) => report.totalTokens))
  return (
    <UsageSection title={t('statsUsage.byAgent', 'By agent')}>
      <View style={{ marginVertical: -8 }}>
        {reports.map((report, index) => (
          <UsageRow
            key={report.id}
            first={index === 0}
            label={USAGE_PROVIDER_LABELS[report.id]}
            value={
              report.enabled
                ? `${formatTokens(report.totalTokens)} · ${formatCost(report.costUsd)}`
                : t('statsUsage.off', 'Off')
            }
            dotColor={providerColor(report.id)}
            share={report.enabled ? report.totalTokens / max : undefined}
            onPress={() => props.onOpen(report.id)}
          />
        ))}
      </View>
    </UsageSection>
  )
}

function ProviderLists(props: { report: UsageProviderReport }) {
  const t = useMobileTranslation()
  const { report } = props
  if (!report.enabled || !report.hasData) {
    return null
  }
  const color = providerColor(report.id)
  return (
    <>
      <BreakdownSection
        title={t('statsUsage.byModel', 'By model')}
        rows={report.models}
        color={color}
      />
      <BreakdownSection
        title={t('statsUsage.byProject', 'By project')}
        rows={report.projects}
        color={color}
      />
      {report.recentSessions.length > 0 ? (
        <UsageSection title={t('statsUsage.recentSessions', 'Recent sessions')}>
          <View style={{ marginVertical: -8 }}>
            {report.recentSessions.map((session, index) => (
              <UsageRow
                key={session.id || index}
                first={index === 0}
                label={session.project || t('statsUsage.unknownProject', 'Unknown project')}
                detail={[
                  formatSessionTime(session.lastActiveAt),
                  session.model,
                  `${session.durationMinutes}m`
                ]
                  .filter(Boolean)
                  .join(' · ')}
                value={formatTokens(session.totalTokens)}
              />
            ))}
          </View>
        </UsageSection>
      ) : null}
    </>
  )
}
