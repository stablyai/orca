import { useMemo, useSyncExternalStore } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import { Slot } from 'expo-router'
import { SafeAreaFrameContext, SafeAreaInsetsContext } from 'react-native-safe-area-context'
import { ZERO_SAFE_AREA_INSETS } from '../src/mobile-web-shell/bridge/bridge-safe-area-insets'
import { usePageBridgeClient } from '../src/transport/client-context.web'
import { colors } from '../src/theme/mobile-theme'

/**
 * The page's root layout, standing where the native `_layout.tsx` does. Without one expo-router
 * mounts `DefaultNavigator`, an all-edges `SafeAreaView`, which would pad each screen a second time.
 * Like the native root it adds no padding. It supplies the insets the shell sent in `init` below
 * ExpoRoot's own provider, whose web half reads `env(safe-area-inset-*)`: 0 in both WebViews.
 */
export default function PageRootLayout() {
  const client = usePageBridgeClient()
  const insets = useSyncExternalStore(
    client.onSafeAreaInsetsUpdate,
    () => client.getShellSession()?.safeAreaInsets ?? ZERO_SAFE_AREA_INSETS
  )
  const { width, height } = useWindowDimensions()
  const frame = useMemo(() => ({ x: 0, y: 0, width, height }), [width, height])
  return (
    <SafeAreaFrameContext.Provider value={frame}>
      <SafeAreaInsetsContext.Provider value={insets}>
        <View style={styles.root}>
          <Slot />
        </View>
      </SafeAreaInsetsContext.Provider>
    </SafeAreaFrameContext.Provider>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bgBase
  }
})
