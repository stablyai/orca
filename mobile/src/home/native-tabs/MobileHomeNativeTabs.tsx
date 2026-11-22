import { useRouter } from 'expo-router'
import { NativeTabs } from 'expo-router/native-tabs'
import { useCallback } from 'react'
import { Platform } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { AndroidSymbol, SFSymbol } from 'expo-symbols'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { HOME_TABS, HOME_TAB_ICONS, homeTabLabels, type HomeTabId } from '../tabs/home-tabs'
import { useMobileHomeController } from '../use-mobile-home-controller'
import { MobileHomeContext } from './mobile-home-context'

// Route names under app/(home); Feed is a group so it keeps the "/" URL.
const TAB_ROUTES: Record<HomeTabId, string> = {
  feed: '(feed)',
  bots: 'bots',
  agents: 'agents',
  usage: 'usage',
  automations: 'automations'
}
const AGENTS_HREF = '/agents'
const BOTS_HREF = '/bots'
const BADGE_TEXT_COLOR = '#000'
const MAX_BADGE = 99
// The bar's height above the bottom inset (Liquid Glass bar on iOS, Material 3 bar on Android), so toasts clear it.
const TAB_BAR_CLEARANCE = Platform.OS === 'ios' ? 62 : 80

function badgeText(count: number): string | undefined {
  return count > 0 ? (count > MAX_BADGE ? `${MAX_BADGE}+` : String(count)) : undefined
}

/** Home's native tab bar: UITabBarController (Liquid Glass on iOS 26) or Material 3 navigation bar. */
export function MobileHomeNativeTabs() {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const seeAllAgents = useCallback(() => router.navigate(AGENTS_HREF), [router])
  const seeAllBots = useCallback(() => router.navigate(BOTS_HREF), [router])
  const home = useMobileHomeController({
    toastBottomInset: insets.bottom + TAB_BAR_CLEARANCE,
    onSeeAllAgents: seeAllAgents,
    onSeeAllBots: seeAllBots
  })
  const labels = homeTabLabels(t)
  const badges: Partial<Record<HomeTabId, string | undefined>> = {
    agents: badgeText(home.data.agentsNeedingYou.length),
    bots: badgeText(home.data.bots.needsYou)
  }

  return (
    // Agent rows swipe; no gesture root sits above Home.
    <GestureHandlerRootView style={styles.fill}>
      <MobileHomeContext.Provider value={home}>
        <NativeTabs
          tintColor={colors.textPrimary}
          iconColor={{ default: colors.textMuted, selected: colors.textPrimary }}
          backgroundColor={colors.bgBase}
          indicatorColor={colors.bgRaised}
          badgeBackgroundColor={colors.statusAmber}
          badgeTextColor={BADGE_TEXT_COLOR}
          // Material 3 labels every destination when there are five or fewer.
          labelVisibilityMode="labeled"
          // Android Back from another tab returns to Feed before it leaves the app.
          backBehavior="initialRoute"
        >
          {HOME_TABS.map((tab) => {
            const symbol = HOME_TAB_ICONS[tab].nativeSymbol
            const badge = badges[tab]
            return (
              <NativeTabs.Trigger key={tab} name={TAB_ROUTES[tab]}>
                <NativeTabs.Trigger.Label>{labels[tab]}</NativeTabs.Trigger.Label>
                {symbol ? (
                  <NativeTabs.Trigger.Icon
                    sf={{
                      default: symbol.ios as SFSymbol,
                      selected: (symbol.iosFill ?? symbol.ios) as SFSymbol
                    }}
                    md={symbol.android as AndroidSymbol}
                  />
                ) : null}
                <NativeTabs.Trigger.Badge hidden={badge === undefined}>
                  {badge}
                </NativeTabs.Trigger.Badge>
              </NativeTabs.Trigger>
            )
          })}
        </NativeTabs>
      </MobileHomeContext.Provider>
      {home.overlays}
    </GestureHandlerRootView>
  )
}

const styles = themedStyleSheet(() => ({
  fill: { flex: 1, backgroundColor: colors.bgBase }
}))
