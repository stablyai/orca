import { startAndroidForegroundPushPresentation } from '../src/notifications/android-foreground-push'
import { registerPushDismissalTask } from '../src/notifications/push-background-dismissal'
import { readNativeNotificationData } from '../src/notifications/native-notification-data'
import { setNotificationViewingWorkspace } from '../src/notifications/notification-viewing-policy'
import { useCallback, useEffect } from 'react'
import { View } from 'react-native'
import { Stack, useGlobalSearchParams, usePathname } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as SplashScreen from 'expo-splash-screen'
import * as Notifications from 'expo-notifications'
import { colors } from '../src/theme/mobile-theme'
import { startMobileAppearance } from '../src/theme/mobile-appearance'
import { themedStyleSheet } from '../src/theme/themed-styles'
import { useMobileColorScheme } from '../src/theme/use-mobile-color-scheme'
import { OrcaLogo } from '../src/components/OrcaLogo'
import { RpcClientProvider } from '../src/transport/client-context'
import { getNotificationNavigationTarget } from '../src/notifications/notification-routing'
import { useOpenNotificationRoute } from '../src/notifications/use-open-notification-route'
import {
  isRemotePushTrigger,
  pushNotificationRouteData,
  foregroundNotificationBehavior
} from '../src/notifications/push-receive'
import { startPushTokenSync } from '../src/notifications/push-registration'
import { ensureDesktopNotificationChannel } from '../src/notifications/desktop-notification-channel'
import { loadHostCatalog } from '../src/transport/host-store'
import { usePairingLinks } from '../src/navigation/use-pairing-links'
import { consumeInitialLaunchIntent } from '../src/navigation/initial-launch-intent'
import { recoverMobileRelayPairing } from '../src/transport/mobile-relay-pairing-recovery'
import { appUpdateChecker } from '../src/app-update/app-update-runtime'
import { SideSafeArea } from '../src/layout/side-safe-area'
import { SideRailProvider } from '../src/layout/side-rail'
import { useFollowDeviceUiLocale } from '../src/i18n/use-follow-device-ui-locale'
import { startMobileUiLanguage } from '../src/i18n/ui-language-preference'
import { subscribeMobileUiLanguage } from '../src/i18n/mobile-i18n'

export { NativeScreenRecovery as ErrorBoundary } from '../src/components/NativeScreenRecovery'

// Keep splash visible until React content is ready to avoid a blank frame.
SplashScreen.preventAutoHideAsync()
// Apply the phone's scheme before the first render; the saved choice lands under the splash.
const appearanceReady = startMobileAppearance()
// Likewise the UI language: the saved choice and its catalog load under the splash.
const languageReady = startMobileUiLanguage()

// Create orca-desktop channel at boot: background FCM can arrive before socket subscription, and Android drops unknown-channel pushes.
void ensureDesktopNotificationChannel().catch(() => {})
// Channel names show in Android settings; rename them in the active language.
subscribeMobileUiLanguage(() => {
  void ensureDesktopNotificationChannel().catch(() => {})
})
void registerPushDismissalTask().catch(() => {})

// Register before scheduling so foreground delivery uses the same suppression policy.
Notifications.setNotificationHandler({
  handleNotification: foregroundNotificationBehavior
})

// Survive root recovery, including shells without clearLastNotificationResponse.
const handledNotificationIds = new Set<string>()

export default function RootLayout() {
  const colorScheme = useMobileColorScheme()
  useFollowDeviceUiLocale()
  const pathname = usePathname()
  const { hostId, worktreeId, executionHost } = useGlobalSearchParams<{
    hostId?: string
    worktreeId?: string
    executionHost?: string
  }>()
  useEffect(() => {
    setNotificationViewingWorkspace(
      pathname.includes('/session/') && typeof hostId === 'string' && typeof worktreeId === 'string'
        ? { hostId, worktreeId, ...(typeof executionHost === 'string' ? { executionHost } : {}) }
        : null
    )
    return () => setNotificationViewingWorkspace(null)
  }, [pathname, hostId, worktreeId, executionHost])
  const openNotificationRoute = useOpenNotificationRoute()
  usePairingLinks()

  useEffect(() => {
    // Reconcile the crash-persistent pairing journal before another scan can replace it.
    void recoverMobileRelayPairing()
  }, [])

  // Re-register rolled APNs/FCM tokens with every paired host or delivery silently stops.
  useEffect(() => startPushTokenSync(), [])
  // Cold start, then foreground and timer checks on the desktop updater's cadence.
  useEffect(() => appUpdateChecker.start(), [])
  useEffect(() => startAndroidForegroundPushPresentation(), [])

  // Notification taps arrive through expo-notifications, not Linking; route both cold and warm responses to their host/worktree.
  useEffect(() => {
    let disposed = false

    function clearLastNotificationResponse() {
      try {
        Notifications.clearLastNotificationResponse()
      } catch {
        // Older native shells may lack clear API; duplicate guards still protect this JS runtime.
      }
    }

    function getInitialNotificationResponse(): Notifications.NotificationResponse | null {
      try {
        return Notifications.getLastNotificationResponse()
      } catch {
        return null
      }
    }

    async function getNavigationTarget(notification: Notifications.Notification) {
      const hosts = await loadHostCatalog().catch(() => null)
      const data = readNativeNotificationData(notification.request)
      // Gateway pushes identify hosts by key fingerprint; without catalog resolution, never fall back to their raw hostId.
      const routeData = pushNotificationRouteData(
        data,
        hosts ?? [],
        isRemotePushTrigger(notification.request.trigger)
      )
      return getNotificationNavigationTarget(routeData, {
        knownHostIds: hosts ? new Set(hosts.map((host) => host.id)) : undefined,
        credentialStatusByHostId: hosts
          ? new Map(hosts.map((host) => [host.id, host.credentialStatus]))
          : undefined
      })
    }

    async function handleNotificationResponse(response: Notifications.NotificationResponse) {
      if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
        clearLastNotificationResponse()
        return
      }

      const notificationId = response.notification.request.identifier
      if (handledNotificationIds.has(notificationId)) {
        return
      }
      handledNotificationIds.add(notificationId)
      // Bound process-lifetime tap dedup with FIFO eviction.
      if (handledNotificationIds.size > 256) {
        const oldest = handledNotificationIds.values().next().value
        if (oldest !== undefined) {
          handledNotificationIds.delete(oldest)
        }
      }

      const target = await getNavigationTarget(response.notification)
      clearLastNotificationResponse()
      if (disposed) {
        return
      }
      if (target) {
        openNotificationRoute(target)
      }
    }

    const initialResponse = consumeInitialLaunchIntent('notification')
      ? getInitialNotificationResponse()
      : null
    if (initialResponse) {
      void handleNotificationResponse(initialResponse)
    }

    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      void handleNotificationResponse(response)
    })
    return () => {
      disposed = true
      sub.remove()
    }
  }, [openNotificationRoute])

  // Hide splash only after Stack layout; a placeholder render can precede real screen content and expose a grey gap.
  const onNavigatorLayout = useCallback(async () => {
    await Promise.all([appearanceReady, languageReady])
    // Let the language switch commit before revealing the first frame.
    await new Promise((resolve) => requestAnimationFrame(resolve))
    await SplashScreen.hideAsync()
  }, [])

  return (
    <RpcClientProvider>
      <View style={styles.root} onLayout={onNavigatorLayout}>
        <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
        <SideRailProvider>
          <SideSafeArea>
            <Stack
              screenOptions={{
                headerStyle: { backgroundColor: colors.bgPanel },
                headerTintColor: colors.textPrimary,
                headerTitleStyle: { fontSize: 16, fontWeight: '600' },
                contentStyle: { backgroundColor: colors.bgBase },
                headerShadowVisible: false
                // Leave orientation unset: react-native-screens overrides rotation lock even for default; Android manifest fullUser honors the user’s setting.
              }}
            >
              <Stack.Screen
                name="index"
                options={{
                  headerShown: false,
                  headerTitle: () => <OrcaLogo size={22} />
                }}
              />
              <Stack.Screen name="pair-scan" options={{ headerShown: false }} />
              <Stack.Screen name="pair" options={{ headerShown: false }} />
              <Stack.Screen name="pair-confirm" options={{ headerShown: false }} />
              <Stack.Screen
                name="mobile-onboarding"
                options={{ headerShown: false, presentation: 'modal', gestureEnabled: false }}
              />
              <Stack.Screen name="settings" options={{ headerShown: false }} />
              <Stack.Screen name="appearance-settings" options={{ headerShown: false }} />
              <Stack.Screen name="terminal-settings" options={{ headerShown: false }} />
              <Stack.Screen name="native-chat-settings" options={{ headerShown: false }} />
              <Stack.Screen name="browser-settings" options={{ headerShown: false }} />
              <Stack.Screen name="voice-settings" options={{ headerShown: false }} />
              <Stack.Screen name="notifications" options={{ headerShown: false }} />
              <Stack.Screen name="troubleshoot" options={{ headerShown: false }} />
              <Stack.Screen name="connection-log" options={{ headerShown: false }} />
              <Stack.Screen name="about" options={{ headerShown: false }} />
              <Stack.Screen name="h" options={{ headerShown: false }} />
              <Stack.Screen
                name="new-workspace"
                options={{
                  headerShown: false,
                  // Draws nothing of its own: the drawer is the page's, over Home.
                  presentation: 'transparentModal',
                  animation: 'none',
                  contentStyle: { backgroundColor: 'transparent' }
                }}
              />
            </Stack>
          </SideSafeArea>
        </SideRailProvider>
      </View>
    </RpcClientProvider>
  )
}

const styles = themedStyleSheet(() => ({
  root: {
    flex: 1,
    backgroundColor: colors.bgBase
  }
}))
