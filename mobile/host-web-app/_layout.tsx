import { Stack, usePathname } from 'expo-router'
import { StyleSheet, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import {
  MobileWebNativeShellProvider,
  useMobileWebNativeShell
} from '../../src/mobile-web/src/native-shell-channel'
import { HostedPageTopInsetProvider } from '../src/mobile-web/hosted-page-top-inset'
import {
  MobileWebNativeBehaviorAdapter,
  installMobileWebNativeBehaviorAdapters
} from '../src/mobile-web/mobile-web-native-behavior-adapter'
import {
  installMobileWebHistoryUrlRewriter,
  pinMobileWebShellSessionFragment,
  stripMobileWebRouteQuery
} from '../src/mobile-web/mobile-web-history-url-rewriter'
import { colors } from '../src/theme/mobile-theme'
import { RpcClientProvider } from '../src/transport/client-context'
import { MobileWebRouteErrorBoundary } from './mobile-web-route-error-boundary'
import { MobileWebRouteRestorer } from './mobile-web-route-restorer'

installMobileWebHistoryUrlRewriter([stripMobileWebRouteQuery, pinMobileWebShellSessionFragment])
installMobileWebNativeBehaviorAdapters()

export default function HostMobileWebLayout() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <HostedPageTopInsetProvider>
          <RpcClientProvider>
            <MobileWebNativeShellProvider>
              <MobileWebRouteRestorer />
              <MobileWebRouteStack />
              <MobileWebNativeBehaviorAdapter />
            </MobileWebNativeShellProvider>
          </RpcClientProvider>
        </HostedPageTopInsetProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}

function MobileWebRouteStack() {
  const pathname = usePathname()
  const shell = useMobileWebNativeShell()
  const contextKey = shell.context
    ? `${shell.context.shellSessionId}:${shell.context.buildId}`
    : 'pending'

  return (
    <View style={styles.root}>
      <MobileWebRouteErrorBoundary resetKey={`${contextKey}:${pathname}`}>
        <Stack screenOptions={{ headerShown: false }} />
      </MobileWebRouteErrorBoundary>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bgBase
  }
})
