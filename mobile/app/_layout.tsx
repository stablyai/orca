import { useCallback } from 'react'
import { View, StyleSheet } from 'react-native'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as SplashScreen from 'expo-splash-screen'
import * as Notifications from 'expo-notifications'
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

export default function RootLayout() {
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
