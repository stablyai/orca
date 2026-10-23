import { useCallback, useState } from 'react'
import { View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { MonitorX } from 'lucide-react-native'
import { LARGE_TITLE_COLLAPSE_OFFSET, NavBar } from '../components/ui/NavBar'
import { StateView } from '../components/ui/StateView'
import { hostScreenStyles as styles } from './host-screen-styles'
import { HostScreenHeader } from './host-screen-header'
import { HostScreenOverlays } from './host-screen-overlays'
import { HostWorkspaceList } from './host-workspace-list'
import { HostBottomToolbar } from './host-bottom-toolbar'
import type { HostScreenController } from './use-host-screen-controller'

export function HostScreenView({ controller }: { controller: HostScreenController }) {
  // The large title scrolls with the list; the bar shows the name once it has gone under.
  const [titleCollapsed, setTitleCollapsed] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  // Phone only: search and New workspace live in a toolbar under the thumb.
  const [searchActive, setSearchActive] = useState(false)
  const [toolbarHeight, setToolbarHeight] = useState(0)
  const phoneToolbar = !controller.embedded
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = event.nativeEvent.contentOffset.y
    setTitleCollapsed(y > LARGE_TITLE_COLLAPSE_OFFSET)
    setScrolled(y > 0)
  }, [])

  if (controller.state.error) {
    return (
      <View style={styles.container}>
        <SafeAreaView style={styles.topChromeSafeArea} edges={['top']}>
          <NavBar onBack={controller.actions.leaveHost} backAccessibilityLabel="Back to desktops" />
        </SafeAreaView>
        <StateView
          icon={MonitorX}
          title="Desktop not found"
          message="This desktop is no longer paired with this phone."
          primary={{
            label: 'Back to desktops',
            onPress: controller.actions.leaveHost
          }}
        />
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.topChromeSafeArea} edges={['top']}>
        <HostScreenHeader
          controller={controller}
          titleVisible={titleCollapsed || (phoneToolbar && searchActive)}
          scrolled={scrolled || (phoneToolbar && searchActive)}
        />
      </SafeAreaView>
      <HostWorkspaceList
        controller={controller}
        onScroll={onScroll}
        bottomChrome={phoneToolbar ? toolbarHeight : 0}
        searchActive={phoneToolbar && searchActive}
      />
      {phoneToolbar ? (
        <HostBottomToolbar
          controller={controller}
          bottomInset={controller.insets.bottom}
          searchActive={searchActive}
          onSearchActiveChange={setSearchActive}
          onLayout={(event) => setToolbarHeight(event.nativeEvent.layout.height)}
        />
      ) : null}
      <HostScreenOverlays controller={controller} />
    </View>
  )
}
