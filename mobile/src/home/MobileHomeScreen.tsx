import { useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import { BackHandler, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { spacing, colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileHomeController } from './use-mobile-home-controller'
import { HOME_TABS, type HomeTabId } from './tabs/home-tabs'
import { MobileHomeFab } from './tabs/MobileHomeFab'
import { MobileHomeTabBar } from './tabs/MobileHomeTabBar'
import { MobileHomeTabContent } from './tabs/MobileHomeTabContent'

// The floating button's height plus its gap above the tab bar.
const FAB_CLEARANCE = 56 + spacing.lg

/** Home with its drawn tab bar; phones use the native tab bar in app/(home) instead. */
export function MobileHomeScreen() {
  useMobileColorScheme()
  const insets = useSafeAreaInsets()
  const [tab, setTab] = useState<HomeTabId>('feed')
  // A tab mounts on first visit and then stays mounted, keeping its scroll and data.
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<HomeTabId>>(() => new Set(['feed']))
  const [automationsHostId, setAutomationsHostId] = useState<string | null>(null)
  const [tabBarHeight, setTabBarHeight] = useState(0)

  const selectTab = useCallback((next: HomeTabId) => {
    setTab(next)
    setVisitedTabs((visited) => (visited.has(next) ? visited : new Set([...visited, next])))
  }, [])
  const seeAllAgents = useCallback(() => selectTab('agents'), [selectTab])
  const seeAllBots = useCallback(() => selectTab('bots'), [selectTab])
  const home = useMobileHomeController({
    toastBottomInset: tabBarHeight,
    onSeeAllAgents: seeAllAgents,
    onSeeAllBots: seeAllBots
  })

  // Android Back from another tab returns to Feed before it leaves the app.
  useFocusEffect(
    useCallback(() => {
      if (tab === 'feed') {
        return undefined
      }
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        selectTab('feed')
        return true
      })
      return () => subscription.remove()
    }, [selectTab, tab])
  )

  const fab = home.createAction(tab, automationsHostId)
  // The floating button covers the last row unless the list can scroll past it.
  const contentBottom = spacing.xl + (fab ? FAB_CLEARANCE : 0)

  return (
    // Agent rows swipe; no gesture root sits above Home.
    <GestureHandlerRootView style={styles.fill}>
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.fill}>
          {HOME_TABS.map((id) =>
            visitedTabs.has(id) ? (
              <View key={id} style={id === tab ? styles.fill : styles.hidden}>
                <MobileHomeTabContent
                  id={id}
                  home={home}
                  bottomInset={contentBottom}
                  onAutomationsHostChange={setAutomationsHostId}
                />
              </View>
            ) : null
          )}
        </View>
        <MobileHomeFab
          visible={fab != null}
          disabled={fab?.disabled ?? false}
          accessibilityLabel={fab?.label ?? ''}
          disabledHint={fab?.hint}
          bottom={tabBarHeight + spacing.lg}
          onPress={() => fab?.onPress()}
        />
        <View onLayout={(event) => setTabBarHeight(event.nativeEvent.layout.height)}>
          <MobileHomeTabBar
            tabs={HOME_TABS}
            active={tab}
            bottomInset={insets.bottom}
            agentsBadge={home.data.agentsNeedingYou.length}
            botsBadge={home.data.bots.needsYou}
            onSelect={selectTab}
          />
        </View>
        {home.overlays}
      </SafeAreaView>
    </GestureHandlerRootView>
  )
}

const styles = themedStyleSheet(() => ({
  container: { flex: 1, backgroundColor: colors.bgBase },
  fill: { flex: 1 },
  hidden: { display: 'none' }
}))
