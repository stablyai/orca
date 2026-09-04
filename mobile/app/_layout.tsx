import { useCallback, useEffect, useRef } from 'react'
import { View, StyleSheet } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as SplashScreen from 'expo-splash-screen'
import * as Notifications from 'expo-notifications'
import * as Linking from 'expo-linking'
import { colors } from '../src/theme/mobile-theme'
import { OrcaLogo } from '../src/components/OrcaLogo'
import { RpcClientProvider } from '../src/transport/client-context'
import { getNotificationNavigationTarget } from '../src/notifications/notification-routing'
import { useOpenNotificationRoute } from '../src/notifications/use-open-notification-route'
import {
  isRemotePushTrigger,
  pushNotificationRouteData,
  shouldSuppressForegroundPush
} from '../src/notifications/push-receive'
import { startPushTokenSync } from '../src/notifications/push-registration'
import { ensureDesktopNotificationChannel } from '../src/notifications/desktop-notification-channel'
import { loadHostCatalog } from '../src/transport/host-store'
import { extractPairingCodeFromUrl } from '../src/transport/pairing'
import { recoverMobileRelayPairing } from '../src/transport/mobile-relay-pairing-recovery'

// Why: keeps the native splash screen visible until the React tree is mounted
// and ready to render. Without this the user sees a blank white/black frame
// between the native splash and the first React paint.
SplashScreen.preventAutoHideAsync()

// Why at boot and not only on subscribe: the gateway's FCM payload targets the
// 'orca-desktop' channel, and a background push can land before any socket has
// connected. Android drops a notification whose channel does not exist yet.
ensureDesktopNotificationChannel()

// Why: without this, expo-notifications silently drops notifications when
// the app is in the foreground. Setting all three to true makes iOS/Android
// display the banner, play the sound, and show the badge even while the
// app is active. This runs once at module load time before any notification
// is scheduled.
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    // Why the check: a gateway push can arrive for an event the socket already
    // delivered, and only the handler can stop the OS drawing a second banner.
    const suppressed = await shouldSuppressForegroundPush(notification.request.content.data).catch(
      () => false
    )
    return {
      shouldShowBanner: !suppressed,
      shouldShowList: !suppressed,
      shouldPlaySound: !suppressed,
      shouldSetBadge: false
    }
  }
})

export default function RootLayout() {
  const router = useRouter()
  const openNotificationRoute = useOpenNotificationRoute()
  const handledNotificationIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    // Why: pairing publication is journaled across process death; startup must
    // reconcile the server result before another scan can replace that journal.
    void recoverMobileRelayPairing()
  }, [])

  // Why: a rolled APNs/FCM token stops delivering silently, so every paired host
  // has to be re-registered with the new one as soon as the provider hands it over.
  useEffect(() => startPushTokenSync(), [])

  // Why: route `orca://pair?...` deep links to the confirm screen so
  // the same pairing flow runs whether the link arrived via QR scan,
  // paste, AirDrop, Messages, or `xcrun simctl openurl`. getInitialURL
  // covers cold-start (link tapped while app was closed); the listener
  // covers warm-start (link tapped while app is in memory).
  useEffect(() => {
    function handleUrl(url: string) {
      const code = extractPairingCodeFromUrl(url)
      if (code) {
        // Why: Android camera launches can leave Expo Router's unmatched
        // `orca://pair` route underneath this screen; replacing keeps cancel
        // and edge-back from revealing the router error page.
        router.replace({ pathname: '/pair-confirm', params: { code } })
      }
    }

    void Linking.getInitialURL().then((url) => {
      if (url) {
        handleUrl(url)
      }
    })

    const sub = Linking.addEventListener('url', ({ url }) => handleUrl(url))
    return () => sub.remove()
  }, [router])

  // ─── Notification tap routing ───
  // Why: iOS delivers local notification taps through expo-notifications,
  // not Linking. Route both cold-start and warm-start responses to the host
  // and worktree that scheduled the notification.
  useEffect(() => {
    let disposed = false

    function clearLastNotificationResponse() {
      try {
        Notifications.clearLastNotificationResponse()
      } catch {
        // Older native shells may not expose the clear API; duplicate guards
        // still protect the current JS runtime.
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
      const data: unknown = notification.request.content.data
      // A gateway push names its host by key fingerprint, not by this device's hostId.
      // With no catalog to resolve against, such a push stays unrouted instead of
      // falling back to whatever hostId its raw data carries.
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
      if (handledNotificationIdsRef.current.has(notificationId)) {
        return
      }
      handledNotificationIdsRef.current.add(notificationId)
      // Why: RootLayout never unmounts, so cap this tap-dedup set (FIFO) rather
      // than letting it grow one id per notification tapped for the app's life.
      if (handledNotificationIdsRef.current.size > 256) {
        const oldest = handledNotificationIdsRef.current.values().next().value
        if (oldest !== undefined) {
          handledNotificationIdsRef.current.delete(oldest)
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

    const initialResponse = getInitialNotificationResponse()
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
  // ─── End notification tap routing ───

  // Why: hide the native splash only once the navigation Stack has been laid
  // out — this is the earliest moment the user will see actual app content.
  // Previously the splash hid when a placeholder View rendered, leaving a
  // grey gap before the real screen appeared.
  const onNavigatorLayout = useCallback(async () => {
    await SplashScreen.hideAsync()
  }, [])

  return (
    <RpcClientProvider>
      <View style={styles.root} onLayout={onNavigatorLayout}>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.bgPanel },
            headerTintColor: colors.textPrimary,
            headerTitleStyle: { fontSize: 16, fontWeight: '600' },
            contentStyle: { backgroundColor: colors.bgBase },
            headerShadowVisible: false
            // Why: deliberately no `orientation` screenOption. react-native-screens
            // has no value that respects the device rotation lock — even 'default'
            // calls setRequestedOrientation(UNSPECIFIED) at runtime, overriding the
            // manifest. Leaving it unset lets the manifest's "fullUser" (set by the
            // android-respect-rotation-lock config plugin) honor the auto-rotate lock.
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
          <Stack.Screen name="terminal-settings" options={{ headerShown: false }} />
          <Stack.Screen name="native-chat-settings" options={{ headerShown: false }} />
          <Stack.Screen name="browser-settings" options={{ headerShown: false }} />
          <Stack.Screen name="voice-settings" options={{ headerShown: false }} />
          <Stack.Screen name="notifications" options={{ headerShown: false }} />
          <Stack.Screen name="troubleshoot" options={{ headerShown: false }} />
          <Stack.Screen name="connection-log" options={{ headerShown: false }} />
          <Stack.Screen name="about" options={{ headerShown: false }} />
          <Stack.Screen name="h" options={{ headerShown: false }} />
        </Stack>
      </View>
    </RpcClientProvider>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bgBase
  }
})
