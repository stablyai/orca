import { useMemo, useSyncExternalStore } from 'react'
import { useWindowDimensions, View } from 'react-native'
import { Slot, usePathname } from 'expo-router'
import { SafeAreaFrameContext, SafeAreaInsetsContext } from 'react-native-safe-area-context'
import { ZERO_SAFE_AREA_INSETS } from '../src/mobile-web-shell/bridge/page-geometry/bridge-safe-area-insets'
import { DetailCardHostProvider } from '../src/components/detail-cards/detail-card-host'
import { SideSafeArea } from '../src/layout/side-safe-area'
import { usePageBridgeClient } from '../src/transport/connection/client-context.web'
import { themedStyleSheet, useThemedStyles } from '../src/theme/themed-styles'
import { isOverlayPageRoute } from '../src/new-workspace/overlay-page-route'

// Provide shell insets below ExpoRoot (WebView CSS env insets are zero); pad only sides to avoid DefaultNavigator’s duplicate all-edge SafeAreaView.
export default function PageRootLayout() {
  const styles = useThemedStyles(stylesSheet)
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
          <DetailCardHostProvider>
            <SideSafeArea>
              <Slot />
            </SideSafeArea>
          </DetailCardHostProvider>
        </View>
      </SafeAreaInsetsContext.Provider>
    </SafeAreaFrameContext.Provider>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  root: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  transparent: {
    backgroundColor: 'transparent'
  }
}))
