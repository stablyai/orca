import { Text, View } from 'react-native'
import type { Translate } from '../i18n/mobile-i18n'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { HomeStatsSummary } from '../stats/home-stats-total'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { MobileHomeAppUpdateCard } from './MobileHomeAppUpdateCard'

function formatDuration(ms: number, t: Translate): string {
  const totalMinutes = Math.floor(ms / 60_000)
  const totalHours = Math.floor(totalMinutes / 60)
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  if (days > 0) {
    return t('home.listHeader.daysHours', '{{days}}d {{hours}}h', { days, hours })
  }
  const minutes = totalMinutes % 60
  return totalHours > 0
    ? t('home.listHeader.hoursMinutes', '{{hours}}h {{minutes}}m', { hours: totalHours, minutes })
    : t('home.listHeader.minutes', '{{minutes}}m', { minutes: totalMinutes })
}

export function MobileHomeListHeader({ stats }: { stats: HomeStatsSummary | null }) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <View>
      <View style={styles.hero}>
        <Text style={styles.heroTitle}>{t('home.listHeader.title', 'Welcome back')}</Text>
      </View>
      {stats ? (
        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>
              {stats.totalAgentsSpawned.toLocaleString(getUiIntlLocale())}
            </Text>
            <Text style={styles.statLabel}>
              {t('home.listHeader.agentsSpawned', 'Agents spawned')}
            </Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{formatDuration(stats.totalAgentTimeMs, t)}</Text>
            <Text style={styles.statLabel}>{t('home.listHeader.agentTime', 'Agent time')}</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>
              {stats.totalPRsCreated.toLocaleString(getUiIntlLocale())}
            </Text>
            <Text style={styles.statLabel}>{t('home.listHeader.prsCreated', 'PRs created')}</Text>
          </View>
        </View>
      ) : null}
      <MobileHomeAppUpdateCard />
      <Text style={styles.sectionHeading}>{t('home.listHeader.desktopsHeading', 'Desktops')}</Text>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  hero: { paddingTop: spacing.xs, paddingBottom: spacing.md },
  heroTitle: {
    color: colors.textPrimary,
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: -0.3
  },
  statsRow: { flexDirection: 'row', gap: 10, marginBottom: spacing.lg },
  statCard: {
    flex: 1,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: spacing.md
  },
  statValue: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.3
  },
  statLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '500', marginTop: 2 },
  sectionHeading: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.xs
  }
}))
