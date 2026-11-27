import { StyleSheet, Text, View } from 'react-native'
import { intlLocaleFor } from '../i18n/ui-intl-locale'
import { useMobileTranslation, useMobileUiLocale } from '../i18n/use-mobile-translation'
import { formatHomeAgentTime, type HomeStatsSummary } from '../stats/home-stats-total'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { homeListStylesSheet } from './home-list-styles'
import { MobileHomeSectionHeading } from './MobileHomeSectionHeading'

/** "Your stats": totals across every paired desktop that has answered, in one row of three. */
export function MobileHomeStats(props: { stats: HomeStatsSummary; first: boolean }) {
  const t = useMobileTranslation()
  const homeListStyles = useThemedStyles(homeListStylesSheet)
  const styles = useThemedStyles(stylesSheet)
  const locale = intlLocaleFor(useMobileUiLocale())
  const cells = [
    {
      key: 'agents',
      value: props.stats.totalAgentsSpawned.toLocaleString(locale),
      label: t('home.stats.agentsSpawned', 'Agents spawned')
    },
    {
      key: 'time',
      value: formatHomeAgentTime(props.stats.totalAgentTimeMs, t),
      label: t('home.stats.agentTime', 'Agent time')
    },
    {
      key: 'prs',
      value: props.stats.totalPRsCreated.toLocaleString(locale),
      label: t('home.stats.prsCreated', 'PRs created')
    }
  ]
  return (
    <>
      <MobileHomeSectionHeading title={t('home.stats.heading', 'Your stats')} first={props.first} />
      <View style={[homeListStyles.group, styles.row]}>
        {cells.map((cell, index) => (
          <View
            key={cell.key}
            accessible
            accessibilityLabel={`${cell.label}, ${cell.value}`}
            style={[styles.cell, index > 0 && styles.divided]}
          >
            <Text style={styles.value} numberOfLines={1}>
              {cell.value}
            </Text>
            <Text style={styles.label} numberOfLines={2}>
              {cell.label}
            </Text>
          </View>
        ))}
      </View>
    </>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  row: { flexDirection: 'row' },
  cell: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    gap: 2,
    paddingTop: 13,
    paddingBottom: 12,
    paddingHorizontal: spacing.sm
  },
  divided: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.borderSubtle },
  value: {
    fontSize: 20,
    lineHeight: 25,
    fontWeight: '600',
    letterSpacing: -0.2,
    color: colors.textPrimary,
    fontVariant: ['tabular-nums']
  },
  label: { fontSize: 13, lineHeight: 17, color: colors.textSecondary, textAlign: 'center' }
}))
