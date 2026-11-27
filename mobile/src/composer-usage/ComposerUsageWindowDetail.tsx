import { StyleSheet, Text, View } from 'react-native'
import type { UsageHistorySample } from '../../../src/shared/agent-usage/rate-limits/usage-window-history'
import { formatResetDuration } from '../../../src/shared/agent-usage/rate-limits/rate-limit-reset-format'
import { UsageBar } from '../accounts/usage/UsageBar'
import type { Translate } from '../i18n/mobile-i18n'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { useMobileColorScheme, useMobileColors } from '../theme/use-mobile-color-scheme'
import { formatUsageWindowLength, type UsageWindowEntry } from './agent-usage-provider'
import { useComposerUsageDisplay } from './composer-usage-display-preference'
import { usagePaceColor } from './usage-pace-color'
import { computeUsagePace, usagePaceMarkerPercent, type UsagePace } from './usage-window-pace'
import { buildUsageChartModel, computeUsageWindowStats } from './usage-window-stats'
import { UsageHistoryChart } from './UsageHistoryChart'

export function windowTitle(entry: UsageWindowEntry, t: Translate): string {
  const length = formatUsageWindowLength(entry.window.windowMinutes)
  switch (entry.kind) {
    case 'session':
      return t('composerUsage.window.sessionTitle', '{{length}} session', { length })
    case 'weekly':
      return t('composerUsage.window.weeklyTitle', 'Weekly')
    case 'fableWeekly':
      return t('composerUsage.window.fableWeeklyTitle', 'Weekly (Fable)')
    case 'monthly':
      return t('composerUsage.window.monthlyTitle', 'Monthly')
    case 'bucket':
      return entry.name ?? length
  }
}

function paceCopy(pace: UsagePace, t: Translate): { text: string; color: string } | null {
  switch (pace.kind) {
    case 'unknown':
      return null
    case 'exhausted':
      return {
        text: t('composerUsage.pace.exhausted', 'Limit reached for this window'),
        color: usagePaceColor(pace, null)
      }
    case 'on-pace':
      return { text: t('composerUsage.pace.onPace', 'On pace'), color: usagePaceColor(pace, null) }
    case 'under':
      return {
        text: t('composerUsage.pace.under', '{{percent}}% under pace', {
          percent: pace.deltaPercent
        }),
        color: usagePaceColor(pace, null)
      }
    case 'ahead':
      return {
        text:
          pace.runOutBeforeResetMs === null
            ? t('composerUsage.pace.ahead', '{{percent}}% ahead of pace', {
                percent: pace.deltaPercent
              })
            : t(
                'composerUsage.pace.aheadRunOut',
                "{{percent}}% ahead of pace — at this rate you'd run out ~{{duration}} before reset",
                {
                  percent: pace.deltaPercent,
                  duration: formatResetDuration(pace.runOutBeforeResetMs)
                }
              ),
        color: usagePaceColor(pace, null)
      }
  }
}

function resetCopy(entry: UsageWindowEntry, now: number, t: Translate): string | null {
  const { resetsAt, resetDescription } = entry.window
  if (resetsAt == null) {
    return resetDescription
  }
  const when = new Date(resetsAt).toLocaleString(getUiIntlLocale(), {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit'
  })
  return t('composerUsage.window.resets', 'Resets {{when}} · in {{duration}}', {
    when,
    duration: formatResetDuration(resetsAt - now)
  })
}

function paceStatus(pace: UsagePace, t: Translate): { text: string; color: string } | null {
  switch (pace.kind) {
    case 'unknown':
      return null
    case 'exhausted':
      return {
        text: t('composerUsage.status.exhausted', 'limit reached'),
        color: usagePaceColor(pace, null)
      }
    case 'on-pace':
      return {
        text: t('composerUsage.status.onPace', 'on pace'),
        color: usagePaceColor(pace, null)
      }
    case 'under':
      return {
        text: t('composerUsage.status.under', 'under pace'),
        color: usagePaceColor(pace, null)
      }
    case 'ahead':
      return {
        text: t('composerUsage.status.ahead', 'ahead of pace'),
        color: usagePaceColor(pace, null)
      }
  }
}

function formatPoints(points: number, t: Translate): string {
  const rounded = Math.round(points)
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : ''
  return t('composerUsage.stats.points', '{{value}} pts', {
    value: `${sign}${Math.abs(rounded)}`
  })
}

function formatBudget(percent: number, perDay: boolean, t: Translate): string {
  const value = percent >= 100 ? Math.round(percent) : percent.toFixed(1)
  return perDay
    ? t('composerUsage.stats.perDay', '{{value}}%/day', { value })
    : t('composerUsage.stats.perHour', '{{value}}%/hour', { value })
}

function StatTile({
  label,
  value,
  color,
  testID
}: {
  label: string
  value: string | null
  color?: string
  testID: string
}) {
  const styles = useThemedStyles(stylesSheet)

  return (
    <View style={styles.tile} testID={testID}>
      <Text style={styles.tileLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text
        style={[styles.tileValue, value !== null && color ? { color } : null]}
        numberOfLines={1}
      >
        {value ?? '—'}
      </Text>
    </View>
  )
}

/** One window expanded: headline, bar with pace tick, four stat tiles and the usage-over-time chart. */
export function ComposerUsageWindowDetail({
  entry,
  samples,
  now
}: {
  entry: UsageWindowEntry
  samples: readonly UsageHistorySample[]
  now: number
}) {
  const styles = useThemedStyles(stylesSheet)
  const colors = useMobileColors()

  useMobileColorScheme()
  const t = useMobileTranslation()
  const display = useComposerUsageDisplay()
  const remaining = display === 'remaining'
  const used = Math.round(Math.max(0, Math.min(100, entry.window.usedPercent)))
  const pace = computeUsagePace(entry.window, now)
  const status = paceStatus(pace, t)
  const runOut =
    pace.kind === 'ahead' && pace.runOutBeforeResetMs !== null ? paceCopy(pace, t) : null
  const reset = resetCopy(entry, now, t)
  const stats = computeUsageWindowStats(entry.window, samples, now)
  const chart = buildUsageChartModel(entry.window, samples, now, display)
  const paceColor = status?.color ?? colors.textPrimary
  const fill = usagePaceColor(pace, used)
  // Remaining counts the other way: under pace leaves more than an even burn would.
  const paceDelta =
    stats.paceDeltaPoints === null
      ? null
      : remaining
        ? -stats.paceDeltaPoints
        : stats.paceDeltaPoints
  const atReset =
    stats.projectedAtReset === null
      ? null
      : remaining
        ? t('composerUsage.stats.left', '{{percent}}% left', {
            percent: Math.round(100 - stats.projectedAtReset)
          })
        : `${Math.round(stats.projectedAtReset)}%`
  const daily = stats.budgetPeriodMs >= 24 * 60 * 60_000
  const recentLabel = daily
    ? t('composerUsage.stats.last24h', 'Used last 24h')
    : t('composerUsage.stats.lastHour', 'Used last hour')
  const length = formatUsageWindowLength(entry.window.windowMinutes)
  return (
    <View style={styles.detail} testID={`composer-usage-window-${entry.id}`}>
      <View style={styles.headlineRow}>
        <Text style={styles.headline}>
          {remaining
            ? t('composerUsage.headline.left', '{{percent}}% left', { percent: 100 - used })
            : t('composerUsage.headline.used', '{{percent}}% used', { percent: used })}
          {status ? (
            <Text style={[styles.status, { color: status.color }]}> {status.text}</Text>
          ) : null}
        </Text>
        {reset ? (
          <Text style={styles.meta} numberOfLines={1}>
            {reset}
          </Text>
        ) : null}
      </View>
      <UsageBar
        label=""
        labelWidth={0}
        usedPercent={used}
        unavailable={false}
        display={display}
        paceMarkerPercent={usagePaceMarkerPercent(entry.window, now, display)}
        fillColor={fill}
      />
      {runOut ? <Text style={[styles.meta, { color: runOut.color }]}>{runOut.text}</Text> : null}
      <View style={styles.tiles}>
        {/* Without a reset time pace, budget and projection have nothing to measure against. */}
        {stats.paceDeltaPoints !== null ? (
          <>
            <StatTile
              label={t('composerUsage.stats.vsPace', 'vs. pace')}
              value={paceDelta === null ? null : formatPoints(paceDelta, t)}
              color={paceColor}
              testID="composer-usage-stat-pace"
            />
            <StatTile
              label={
                daily
                  ? t('composerUsage.stats.budgetDaily', 'Daily budget')
                  : t('composerUsage.stats.budgetHourly', 'Hourly budget')
              }
              value={
                stats.budgetPercent === null ? null : formatBudget(stats.budgetPercent, daily, t)
              }
              testID="composer-usage-stat-budget"
            />
            <StatTile
              label={t('composerUsage.stats.atReset', 'At reset')}
              value={atReset}
              testID="composer-usage-stat-at-reset"
            />
          </>
        ) : null}
        <StatTile
          label={recentLabel}
          value={stats.recentPoints === null ? null : formatPoints(stats.recentPoints, t)}
          testID="composer-usage-stat-recent"
        />
      </View>
      {chart ? (
        <View style={styles.chart}>
          <UsageHistoryChart
            model={chart}
            color={fill}
            accessibilityLabel={t(
              'composerUsage.chart.label',
              '{{window}} usage over time, with a dashed line for an even pace',
              { window: length }
            )}
          />
          <Text style={styles.caption}>
            {chart.pace
              ? t('composerUsage.chart.legend', 'Dashed line: an even pace to reset')
              : t('composerUsage.chart.legendNoReset', 'Usage since the first reading')}
          </Text>
        </View>
      ) : (
        <View style={styles.collecting} testID="composer-usage-chart-collecting">
          <Text style={styles.caption}>
            {t(
              'composerUsage.chart.collecting',
              'Collecting usage history. The graph fills in as the desktop checks usage.'
            )}
          </Text>
        </View>
      )}
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  detail: {
    gap: spacing.sm,
    paddingVertical: spacing.md
  },
  headlineRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    columnGap: spacing.sm,
    rowGap: spacing.xxs
  },
  headline: {
    fontSize: typography.titleSize,
    fontWeight: '700',
    color: colors.textPrimary,
    fontVariant: ['tabular-nums']
  },
  status: {
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  meta: {
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums']
  },
  tiles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.xs
  },
  tile: {
    flexGrow: 1,
    flexBasis: '40%',
    gap: spacing.xxs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.control,
    backgroundColor: colors.sheetGroup
  },
  tileLabel: {
    fontSize: typography.metaSize,
    color: colors.textSecondary
  },
  tileValue: {
    fontSize: typography.titleSize,
    fontWeight: '600',
    color: colors.textPrimary,
    fontVariant: ['tabular-nums']
  },
  chart: {
    gap: spacing.xs,
    marginTop: spacing.xs
  },
  caption: {
    fontSize: typography.metaSize,
    color: colors.textMuted
  },
  collecting: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 64,
    paddingHorizontal: spacing.md,
    borderRadius: radii.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    borderColor: colors.borderSubtle,
    marginTop: spacing.xs
  }
}))
