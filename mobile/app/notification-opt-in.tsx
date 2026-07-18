import { useCallback, useState } from 'react'
import {
  ActivityIndicator,
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { BellRing } from 'lucide-react-native'
import { OrcaLogo } from '../src/components/OrcaLogo'
import { ensureNotificationPermissions } from '../src/notifications/mobile-notifications'
import { savePushNotificationsEnabled } from '../src/storage/preferences'
import { colors, radii, spacing, typography } from '../src/theme/mobile-theme'

export default function NotificationOptInScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ hostId?: string | string[] }>()
  const hostId = Array.isArray(params.hostId) ? params.hostId[0] : params.hostId
  const [busyChoice, setBusyChoice] = useState<'enable' | 'skip' | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Why: this one-time screen requires an explicit Enable or Not now choice;
  // disabling back gestures alone would still leave Android hardware back open.
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => true)
      return () => subscription.remove()
    }, [])
  )

  const continueToApp = useCallback(() => {
    router.replace(hostId ? `/h/${hostId}` : '/')
  }, [hostId, router])

  const choose = useCallback(
    async (choice: 'enable' | 'skip') => {
      if (busyChoice) {
        return
      }
      setBusyChoice(choice)
      setError(null)
      try {
        const enabled = choice === 'enable' ? await ensureNotificationPermissions() : false
        await savePushNotificationsEnabled(enabled)
        continueToApp()
      } catch {
        setError('Notification settings could not be updated. Try again.')
        setBusyChoice(null)
      }
    },
    [busyChoice, continueToApp]
  )

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.brandRow}>
          <OrcaLogo size={22} />
          <Text style={styles.brandName}>Orca</Text>
        </View>

        <View style={styles.content}>
          <View style={styles.iconSurface}>
            <BellRing size={30} color={colors.textPrimary} />
          </View>
          <Text style={styles.eyebrow}>Notifications</Text>
          <Text style={styles.title}>Stay updated while away</Text>
          <Text style={styles.body}>
            Get notified on this device when an agent needs your input or finishes a task.
          </Text>
        </View>

        <View style={styles.footer}>
          {error ? (
            <Text style={styles.error} accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Enable agent notifications"
            disabled={busyChoice !== null}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.buttonPressed,
              busyChoice !== null && styles.buttonDisabled
            ]}
            onPress={() => void choose('enable')}
          >
            {busyChoice === 'enable' ? (
              <ActivityIndicator color={colors.bgBase} />
            ) : (
              <Text style={styles.primaryButtonText}>Enable notifications</Text>
            )}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busyChoice !== null}
            style={({ pressed }) => [
              styles.secondaryButton,
              pressed && styles.buttonPressed,
              busyChoice !== null && styles.buttonDisabled
            ]}
            onPress={() => void choose('skip')}
          >
            {busyChoice === 'skip' ? (
              <ActivityIndicator color={colors.textSecondary} />
            ) : (
              <Text style={styles.secondaryButtonText}>Not now</Text>
            )}
          </Pressable>
          <Text style={styles.footerNote}>You can change this any time in Settings.</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
    paddingHorizontal: spacing.xl
  },
  // Why: this decision screen cannot be dismissed with Back, so every action
  // must remain reachable in landscape and with accessibility text scaling.
  scrollContent: {
    flexGrow: 1
  },
  brandRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  brandName: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: '700'
  },
  content: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xl
  },
  iconSurface: {
    width: 64,
    height: 64,
    borderRadius: radii.card,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    marginBottom: spacing.xl
  },
  eyebrow: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.55,
    textTransform: 'uppercase',
    marginBottom: spacing.sm
  },
  title: {
    maxWidth: 420,
    color: colors.textPrimary,
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: -0.3,
    textAlign: 'center'
  },
  body: {
    maxWidth: 420,
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    lineHeight: 21,
    textAlign: 'center',
    marginTop: spacing.md
  },
  footer: {
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    paddingBottom: spacing.lg
  },
  primaryButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button,
    backgroundColor: colors.surfaceBright,
    paddingVertical: spacing.sm
  },
  primaryButtonText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  secondaryButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button,
    marginTop: spacing.xs,
    paddingVertical: spacing.sm
  },
  secondaryButtonText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  },
  buttonPressed: {
    opacity: 0.72
  },
  buttonDisabled: {
    opacity: 0.58
  },
  footerNote: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: spacing.sm
  },
  error: {
    color: colors.statusRed,
    fontSize: typography.metaSize,
    lineHeight: 18,
    textAlign: 'center',
    marginBottom: spacing.sm
  }
})
