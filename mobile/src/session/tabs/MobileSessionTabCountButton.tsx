import { Pressable, Text, View } from 'react-native'
import { Bell } from 'lucide-react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, radii } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

/** Boxed `[N]` tab-switcher trigger with unread bell & `Needs you` dot, shared across bar & strip modes. */
export function MobileSessionTabCountButton({
  count,
  anyUnread = false,
  othersNeedYou,
  active = false,
  leadingBorder = false,
  isLastCell = false,
  onPress
}: {
  count: number
  anyUnread?: boolean
  othersNeedYou: boolean
  active?: boolean
  leadingBorder?: boolean
  isLastCell?: boolean
  onPress: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const countLabel =
    count === 1
      ? t('session.tabBar.oneTab', '1 tab')
      : t('session.tabBar.tabCount', '{{count}} tabs', { count })
  const accessibilityLabel = [
    countLabel,
    anyUnread ? t('agents.list.unread', 'Unread') : null,
    othersNeedYou ? t('session.tabBar.anotherNeedsYou', 'another tab needs you') : null
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <Pressable
      style={({ pressed }) => [
        styles.sideCell,
        leadingBorder && styles.leadingBorder,
        isLastCell && styles.lastCell,
        active && styles.sideCellActive,
        pressed && styles.cellPressed
      ]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={t('session.tabBar.hint', 'Shows all tabs')}
    >
      <View style={styles.countBox}>
        <Text style={styles.countText}>{count}</Text>
      </View>
      {anyUnread ? <Bell size={12} color={colors.statusAmber} fill={colors.statusAmber} /> : null}
      {othersNeedYou ? <View style={styles.alert} /> : null}
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  sideCell: {
    width: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRightWidth: 1,
    borderRightColor: colors.borderSubtle
  },
  leadingBorder: {
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSubtle
  },
  lastCell: { borderRightWidth: 0 },
  sideCellActive: { backgroundColor: colors.bgRaised },
  cellPressed: { backgroundColor: colors.translucentFill },
  countBox: {
    minWidth: 19,
    height: 19,
    paddingHorizontal: 3,
    borderRadius: 6,
    borderWidth: 1.8,
    borderColor: colors.textPrimary,
    alignItems: 'center',
    justifyContent: 'center'
  },
  countText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textPrimary,
    fontVariant: ['tabular-nums']
  },
  alert: {
    position: 'absolute',
    top: 8,
    right: 9,
    width: 9,
    height: 9,
    borderRadius: radii.pill,
    backgroundColor: colors.statusRed,
    borderWidth: 2,
    borderColor: colors.bgPanel
  }
}))
