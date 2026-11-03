import { ChevronRight } from 'lucide-react-native'
import { Fragment } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ClaudeIcon, OpenAIIcon } from '../components/AgentIcons'
import { getUsageBarState, usageBarFill } from '../components/AccountUsage'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useHostDisplay } from '../transport/use-host-display'
import type { HomeAccountUsageRow } from './home-account-usage-rows'
import { homeListStyles } from './home-list-styles'
import { MobileHomeSectionHeading } from './MobileHomeSectionHeading'

const PROVIDER_NAMES = { claude: 'Claude', codex: 'Codex' } as const

/** "Account usage": each connected desktop's active account per provider; a tap opens its Accounts screen. */
export function MobileHomeAccountUsage(props: {
  rows: readonly HomeAccountUsageRow[]
  /** With more than one desktop paired, each row says whose account it is. */
  nameDesktops: boolean
  first: boolean
  onOpen: (hostId: string) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <>
      <MobileHomeSectionHeading
        title={t('home.accountUsage.heading', 'Account usage')}
        first={props.first}
      />
      <View style={homeListStyles.group}>
        {props.rows.map((row, index) => (
          <Fragment key={`${row.host.id}:${row.provider}`}>
            {index > 0 ? <View style={homeListStyles.separator} /> : null}
            <AccountUsageRow row={row} nameDesktop={props.nameDesktops} onOpen={props.onOpen} />
          </Fragment>
        ))}
      </View>
    </>
  )
}

function AccountUsageRow(props: {
  row: HomeAccountUsageRow
  nameDesktop: boolean
  onOpen: (hostId: string) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { row } = props
  const desktopName = useHostDisplay(row.host).title
  const provider = PROVIDER_NAMES[row.provider]
  const account = row.email ?? t('home.accountUsage.systemDefault', 'System default')
  const meters = [
    {
      label: t('home.accountUsage.sessionWindow', '5h'),
      ...getUsageBarState(row.limits, 'session')
    },
    { label: t('home.accountUsage.weeklyWindow', '7d'), ...getUsageBarState(row.limits, 'weekly') }
  ].map((meter) => ({ ...meter, ...usageBarFill(meter.usedPercent, meter.unavailable) }))
  const percentText = (used: number | null, unavailable: boolean) =>
    unavailable || used == null ? '—' : `${used}%`

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        provider,
        props.nameDesktop ? desktopName : null,
        account,
        ...meters.map((meter) => `${meter.label} ${percentText(meter.used, meter.unavailable)}`)
      ]
        .filter(Boolean)
        .join(', ')}
      style={({ pressed }) => [homeListStyles.row, pressed && homeListStyles.rowPressed]}
      onPress={() => props.onOpen(row.host.id)}
    >
      <View style={homeListStyles.status}>
        {row.provider === 'claude' ? (
          <ClaudeIcon size={18} />
        ) : (
          <OpenAIIcon size={18} color={colors.textPrimary} />
        )}
      </View>
      <View style={homeListStyles.text}>
        <View style={styles.titleLine}>
          <Text style={[homeListStyles.title, styles.provider]} numberOfLines={1}>
            {provider}
          </Text>
          {props.nameDesktop ? (
            <Text style={styles.desktop} numberOfLines={1}>
              {desktopName}
            </Text>
          ) : null}
        </View>
        <Text style={homeListStyles.subtitle} numberOfLines={1}>
          {account}
        </Text>
        <View style={styles.meters}>
          {meters.map((meter) => (
            <View key={meter.label} style={styles.meter}>
              <Text style={styles.meterLabel}>{meter.label}</Text>
              <View style={styles.track}>
                <View
                  style={[
                    styles.fill,
                    { width: `${meter.used ?? 0}%`, backgroundColor: meter.color }
                  ]}
                />
              </View>
              <Text style={styles.meterValue}>{percentText(meter.used, meter.unavailable)}</Text>
            </View>
          ))}
        </View>
      </View>
      <View style={[homeListStyles.trailing, styles.trailing]}>
        <ChevronRight size={16} color={colors.textMuted} />
      </View>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  titleLine: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, minWidth: 0 },
  provider: { flexShrink: 1 },
  desktop: {
    marginLeft: 'auto',
    flexShrink: 0,
    maxWidth: '50%',
    fontSize: 13,
    color: colors.textMuted
  },
  meters: { flexDirection: 'row', gap: spacing.lg, marginTop: 9 },
  meter: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 7 },
  meterLabel: { fontSize: 13, color: colors.textMuted },
  track: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.bgRaised,
    overflow: 'hidden'
  },
  fill: { height: '100%', borderRadius: 2 },
  meterValue: {
    minWidth: 30,
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
    textAlign: 'right',
    fontVariant: ['tabular-nums']
  },
  trailing: { paddingLeft: 12 }
}))
