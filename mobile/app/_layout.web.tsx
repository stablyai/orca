import { useMemo, useSyncExternalStore } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import { Slot, usePathname } from 'expo-router'
import { SafeAreaFrameContext, SafeAreaInsetsContext } from 'react-native-safe-area-context'
import { ZERO_SAFE_AREA_INSETS } from '../src/mobile-web-shell/bridge/bridge-safe-area-insets'
import { SideSafeArea } from '../src/layout/side-safe-area'
import { usePageBridgeClient } from '../src/transport/client-context.web'
import { colors } from '../src/theme/mobile-theme'
import { isOverlayPageRoute } from '../src/new-workspace/overlay-page-route'

// Provide shell insets below ExpoRoot (WebView CSS env insets are zero); pad only sides to avoid DefaultNavigator’s duplicate all-edge SafeAreaView.
export default function PageRootLayout() {
  const client = usePageBridgeClient()
  const insets = useSyncExternalStore(
    client.onSafeAreaInsetsUpdate,
    () => client.getShellSession()?.safeAreaInsets ?? ZERO_SAFE_AREA_INSETS
  )
  const { width, height } = useWindowDimensions()
  const transparent = isOverlayPageRoute(usePathname())
  const frame = useMemo(() => ({ x: 0, y: 0, width, height }), [width, height])
  return (
    <SafeAreaFrameContext.Provider value={frame}>
      <SafeAreaInsetsContext.Provider value={insets}>
        <View style={[styles.root, transparent && styles.transparent]}>
          <SideSafeArea>
            <Slot />
          </SideSafeArea>
        </View>
      </SafeAreaInsetsContext.Provider>
    </SafeAreaFrameContext.Provider>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  transparent: {
    backgroundColor: 'transparent'
  }
})
