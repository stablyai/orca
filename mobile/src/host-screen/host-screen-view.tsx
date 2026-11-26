import { ChevronLeft } from 'lucide-react-native'
import { lazy, Suspense, useCallback, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { NavBar } from '../components/nav-bar/NavBar'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { PageTitle, useCollapsingTitle } from '../components/nav-bar/PageTitle'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useBackClaim } from '../navigation/use-back-claim'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { hostScreenStyles as styles } from './host-screen-styles'
import { HostBottomBar } from './host-bottom-bar'
import { HostConnectionStatus, HostScreenHeader } from './host-screen-header'
import { HostScreenOverlays } from './host-screen-overlays'
import { HostWorkspaceList } from './workspace-list/host-workspace-list'
import type { HostScreenController } from './use-host-screen-controller'

const HostCommanderScreen = lazy(() => import('./host-commander-screen'))

function CommanderLoading({ title, onBack }: { title: string; onBack: () => void }) {
  const t = useMobileTranslation()
  useBackClaim(() => {
    onBack()
    return true
  })
  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <NavBar
        title={title}
        leading={
          <NavBarButton
            icon={ChevronLeft}
            accessibilityLabel={t('common.back', 'Back')}
            onPress={onBack}
          />
        }
      />
      <ActivityIndicator style={styles.centered} />
    </SafeAreaView>
  )
}

export function HostScreenView({ controller }: { controller: HostScreenController }) {
  useMobileColorScheme()
  const [commanderHost, setCommanderHost] = useState<string | null>(null)
  const [commanderOpen, setCommanderOpen] = useState(false)
  const closeCommander = useCallback(() => setCommanderOpen(false), [])
  const openCommander = () => {
    setCommanderHost(controller.hostId)
    setCommanderOpen(true)
  }
  const mountedCommander = commanderHost !== null && commanderHost === controller.hostId
  const showingCommander = mountedCommander && commanderOpen
  const [bottomBarHeight, setBottomBarHeight] = useState(0)
  const listRef = controller.activeWorktreeScroll.sectionListRef
  const scrollTo = useCallback(
    (offset: number) =>
      listRef.current?.getScrollResponder()?.scrollTo({ y: offset, animated: true }),
    [listRef]
  )
  const collapsingTitle = useCollapsingTitle(scrollTo)
  return (
    <View style={styles.container}>
      {mountedCommander && (
        <View style={showingCommander ? styles.container : layout.hidden}>
          <Suspense
            fallback={
              showingCommander && (
                <CommanderLoading title={controller.hostDisplay.title} onBack={closeCommander} />
              )
            }
          >
            <HostCommanderScreen
              key={commanderHost}
              controller={controller}
              active={showingCommander}
              onClose={closeCommander}
            />
          </Suspense>
        </View>
      )}
      {!showingCommander &&
        (controller.state.error ? (
          <View style={styles.centered}>
            <Text style={styles.errorText}>{controller.state.error}</Text>
          </View>
        ) : (
          <>
            <SafeAreaView style={styles.topChromeSafeArea} edges={['top']}>
              <HostScreenHeader
                controller={controller}
                collapsingTitle={collapsingTitle}
                onOpenCommander={openCommander}
              />
            </SafeAreaView>
            <HostWorkspaceList
              controller={controller}
              bottomBarHeight={bottomBarHeight}
              pageTitle={{
                element: (
                  <PageTitle
                    title={controller.hostDisplay.title}
                    subtitle={<HostConnectionStatus controller={controller} />}
                    onLayout={collapsingTitle.onTitleLayout}
                  />
                ),
                collapsing: collapsingTitle
              }}
            />
            <HostBottomBar controller={controller} onCoveredHeightChange={setBottomBarHeight} />
            <HostScreenOverlays controller={controller} />
          </>
        ))}
    </View>
  )
}

const layout = StyleSheet.create({ hidden: { display: 'none' } })
