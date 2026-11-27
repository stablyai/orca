import { createContext, useContext } from 'react'
import { Text, View } from 'react-native'
import { NavBarButton } from '../../components/nav-bar/NavBarButton'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import {
  countMobileSessionDesktopTabs,
  type MobileSessionTabSummary
} from './mobile-session-tab-rows'

const CountContext = createContext(0)

// NavBarButton draws an icon; this one is the tab count in a box, in the colour the button gives it.
function TabCountGlyph({ color = colors.textPrimary }: { color?: string }) {
  const count = useContext(CountContext)
  return (
    <View style={[styles.box, { borderColor: color }]}>
      <Text style={[styles.count, { color }]}>{count > 99 ? '99+' : count}</Text>
    </View>
  )
}

/** The boxed tab count that opens the sidebar, with how many other tabs need you on its corner. */
export function MobileSessionTabsButton({
  tabs,
  activeTabId,
  alsoNeedYou,
  active,
  onPress
}: {
  tabs: readonly MobileSessionTabSummary[]
  activeTabId: string | null
  /** Others in the sidebar that need you, e.g. a bot's items. */
  alsoNeedYou: number
  /** The docked sidebar is showing. */
  active: boolean
  onPress: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const count = countMobileSessionDesktopTabs(tabs)
  const needYou =
    countMobileSessionDesktopTabs(
      tabs.filter((row) => row.tab.id !== activeTabId && row.group === 'needs-you')
    ) + alsoNeedYou
  const countLabel =
    count === 1
      ? t('session.tabBar.oneTab', '1 tab')
      : t('session.tabBar.tabCount', '{{count}} tabs', { count })
  const needYouLabel =
    needYou === 1
      ? t('session.tabBar.needYou_one', '{{count}} needs you', { count: needYou })
      : t('session.tabBar.needYou_other', '{{count}} need you', { count: needYou })
  return (
    <CountContext.Provider value={count}>
      <NavBarButton
        icon={TabCountGlyph}
        active={active}
        accessibilityLabel={needYou > 0 ? `${countLabel}, ${needYouLabel}` : countLabel}
        badge={{ count: needYou, color: colors.agentQuestion }}
        onPress={onPress}
      />
    </CountContext.Provider>
  )
}

// The strip's count cell, kept: a 19 pt box with a 1.8 pt line.
const styles = themedStyleSheet(() => ({
  box: {
    minWidth: 19,
    height: 19,
    paddingHorizontal: 3,
    borderRadius: 6,
    borderWidth: 1.8,
    alignItems: 'center',
    justifyContent: 'center'
  },
  count: { fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] }
}))
