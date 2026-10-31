import { StyleSheet, Text, View } from 'react-native'
import { formatResetDuration } from '../../../src/shared/rate-limit-reset-format'
import { UsageBar } from '../components/AccountUsage'
import type { Translate } from '../i18n/mobile-i18n'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { formatUsageWindowLength, type UsageWindowEntry } from './agent-usage-provider'
import { computeUsagePace, type UsagePace } from './usage-window-pace'

function windowTitle(entry: UsageWindowEntry, t: Translate): string {
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
    case 'on-pace':
      return { text: t('composerUsage.pace.onPace', 'On pace'), color: colors.textSecondary }
    case 'under':
      return {
        text: t('composerUsage.pace.under', '{{percent}}% under pace', {
          percent: pace.deltaPercent
        }),
        color: colors.statusGreen
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
        color: pace.runOutBeforeResetMs === null ? colors.statusAmber : colors.statusRed
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

export function ComposerUsageWindowRow({ entry, now }: { entry: UsageWindowEntry; now: number }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const used = Math.round(Math.max(0, Math.min(100, entry.window.usedPercent)))
  const pace = paceCopy(computeUsagePace(entry.window, now), t)
  const reset = resetCopy(entry, now, t)
  return (
    <View style={styles.row} testID={`composer-usage-window-${entry.id}`}>
      <View style={styles.titleRow}>
        <Text style={styles.title} numberOfLines={1}>
          {windowTitle(entry, t)}
        </Text>
        <Text style={styles.meta}>
          {t('composerUsage.window.usedLeft', '{{used}}% used · {{left}}% left', {
            used,
            left: 100 - used
          })}
        </Text>
      </View>
      <UsageBar
        label={formatUsageWindowLength(entry.window.windowMinutes)}
        usedPercent={used}
        unavailable={false}
      />
      {reset ? <Text style={styles.meta}>{reset}</Text> : null}
      {pace ? <Text style={[styles.pace, { color: pace.color }]}>{pace.text}</Text> : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  row: {
    gap: spacing.xs,
    paddingVertical: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  title: {
    flexShrink: 1,
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textPrimary
  },
  meta: {
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums']
  },
  pace: {
    fontSize: typography.metaSize,
    fontWeight: '500'
  }
}))
