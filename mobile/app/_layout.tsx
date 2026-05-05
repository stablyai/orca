import { useCallback, useEffect } from 'react'
import { View, StyleSheet } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as SplashScreen from 'expo-splash-screen'
import * as Notifications from 'expo-notifications'
import * as Linking from 'expo-linking'
import { colors } from '../src/theme/mobile-theme'
import { OrcaLogo } from '../src/components/OrcaLogo'

// Why: keeps the native splash screen visible until the React tree is mounted
// and ready to render. Without this the user sees a blank white/black frame
// between the native splash and the first React paint.
SplashScreen.preventAutoHideAsync()

// Why: without this, expo-notifications silently drops notifications when
// the app is in the foreground. Setting all three to true makes iOS/Android
// display the banner, play the sound, and show the badge even while the
// app is active. This runs once at module load time before any notification
// is scheduled.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false
  })
})

// Why: extract the path+payload that follows the orca://pair anchor so we
// can route it to the confirm screen. Accept either a hash payload
// (`orca://pair#<base64>`, the QR / shared form) or a query param
// (`orca://pair?code=<...>`, future-proof for share sheets that strip
// fragments).
function extractPairCode(url: string): string | null {
  if (!url.startsWith('orca://pair')) return null
  const hashIndex = url.indexOf('#')
  if (hashIndex !== -1) {
    return url.slice(hashIndex + 1) || null
  }
  const queryIndex = url.indexOf('?')
  if (queryIndex !== -1) {
    const params = new URLSearchParams(url.slice(queryIndex + 1))
    return params.get('code')
  }
  return null
}

export default function RootLayout() {
  const router = useRouter()

  // Why: route `orca://pair#<code>` deep links to the confirm screen so
  // the same pairing flow runs whether the link arrived via QR scan,
  // paste, AirDrop, Messages, or `xcrun simctl openurl`. getInitialURL
  // covers cold-start (link tapped while app was closed); the listener
  // covers warm-start (link tapped while app is in memory).
  useEffect(() => {
    function handleUrl(url: string) {
      const code = extractPairCode(url)
      if (code) {
        router.push({ pathname: '/pair-confirm', params: { code } })
      }
    }

    void Linking.getInitialURL().then((url) => {
      if (url) handleUrl(url)
    })

    const sub = Linking.addEventListener('url', ({ url }) => handleUrl(url))
    return () => sub.remove()
  }, [router])

  // Why: hide the native splash only once the navigation Stack has been laid
  // out — this is the earliest moment the user will see actual app content.
  // Previously the splash hid when a placeholder View rendered, leaving a
  // grey gap before the real screen appeared.
  const onNavigatorLayout = useCallback(async () => {
    await SplashScreen.hideAsync()
  }, [])

  return (
    <View style={styles.root} onLayout={onNavigatorLayout}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bgPanel },
          headerTintColor: colors.textPrimary,
          headerTitleStyle: { fontSize: 16, fontWeight: '600' },
          contentStyle: { backgroundColor: colors.bgBase },
          headerShadowVisible: false
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
        <Stack.Screen name="pair-confirm" options={{ headerShown: false }} />
        <Stack.Screen name="settings" options={{ headerShown: false }} />
        <Stack.Screen name="notifications" options={{ headerShown: false }} />
        <Stack.Screen name="troubleshoot" options={{ headerShown: false }} />
        <Stack.Screen name="about" options={{ headerShown: false }} />
        <Stack.Screen name="h" options={{ headerShown: false }} />
      </Stack>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bgBase
  }
})
