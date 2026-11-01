import { useCallback, useState } from 'react'
import { Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { PageTitle, useCollapsingTitle } from '../components/nav-bar/PageTitle'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { hostScreenStyles as styles } from './host-screen-styles'
import { HostBottomBar } from './host-bottom-bar'
import { HostConnectionStatus, HostScreenHeader } from './host-screen-header'
import { HostScreenOverlays } from './host-screen-overlays'
import { HostWorkspaceList } from './host-workspace-list'
import type { HostScreenController } from './use-host-screen-controller'

export function HostScreenView({ controller }: { controller: HostScreenController }) {
  useMobileColorScheme()
  const [bottomBarHeight, setBottomBarHeight] = useState(0)
  const listRef = controller.activeWorktreeScroll.sectionListRef
  const scrollTo = useCallback(
    (offset: number) =>
      listRef.current?.getScrollResponder()?.scrollTo({ y: offset, animated: true }),
    [listRef]
  )
  const collapsingTitle = useCollapsingTitle(scrollTo)
  if (controller.state.error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{controller.state.error}</Text>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.topChromeSafeArea} edges={['top']}>
        <HostScreenHeader controller={controller} collapsingTitle={collapsingTitle} />
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
    </View>
  )
}
