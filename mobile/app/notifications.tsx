import { NotificationDeliverySection } from '../src/notifications/NotificationDeliverySection'
import {
  DEFAULT_NOTIFICATION_DELIVERY,
  loadNotificationDeliveryPreferences,
  type NotificationDeliveryPreferences
} from '../src/notifications/notification-delivery-preferences'
import { useState, useCallback, useEffect } from 'react'
import {
  AppState,
  Linking,
  View,
  Text,
  StyleSheet,
  Pressable,
  Switch,
  ScrollView,
  Alert
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter, useFocusEffect } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import { colors, spacing, typography } from '../src/theme/mobile-theme'
import { loadPushNotificationsEnabled } from '../src/storage/preferences'
import {
  setNotificationDeliveryPreferences,
  setRemotePushEnabled
} from '../src/notifications/push-registration'
import { useRemotePushCapableHosts } from '../src/notifications/use-remote-push-capable-hosts'
import {
  ensureNotificationPermissions,
  getNotificationPermissionState,
  type NotificationPermissionState
} from '../src/notifications/mobile-notifications'

const DEFAULT_PERMISSION_STATE: NotificationPermissionState = {
  granted: false,
  status: 'undetermined',
  canAskAgain: true,
  authorizationReflectsUserChoice: false
}

export default function NotificationsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [pushEnabled, setPushEnabled] = useState(false)
  const [permissionState, setPermissionState] = useState(DEFAULT_PERMISSION_STATE)
  const [delivery, setDelivery] = useState(DEFAULT_NOTIFICATION_DELIVERY)
  const [saving, setSaving] = useState(false)
  const remotePushSupport = useRemotePushCapableHosts()

  const refreshSettings = useCallback(async () => {
    const [enabled, permission, states] = await Promise.all([
      loadPushNotificationsEnabled(),
      getNotificationPermissionState(),
      loadNotificationDeliveryPreferences()
    ])
    setPushEnabled(enabled)
    setPermissionState(permission)
    setDelivery(states)
  }, [])

  useFocusEffect(
    useCallback(() => {
      void refreshSettings()
    }, [refreshSettings])
  )

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refreshSettings()
      }
    })
    return () => subscription.remove()
  }, [refreshSettings])

  const togglePush = async (value: boolean) => {
    setSaving(true)
    try {
      if (value) {
        const granted = await ensureNotificationPermissions()
        const permission = await getNotificationPermissionState()
        setPermissionState(permission)
        if (!granted) {
          setPushEnabled(false)
          await setRemotePushEnabled(false)
          return
        }
      }
      setPushEnabled(value)
      await setRemotePushEnabled(value)
    } catch {
      Alert.alert('Could not save notification settings', 'Please try again.')
      await refreshSettings()
    } finally {
      setSaving(false)
    }
  }

  const changeDelivery = async (value: NotificationDeliveryPreferences) => {
    setSaving(true)
    try {
      await setNotificationDeliveryPreferences(value)
      setDelivery(value)
    } catch {
      Alert.alert('Could not save notification settings', 'Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const switchEnabled = pushEnabled && permissionState.granted
  const notificationsBlocked = permissionState.status === 'denied'
  const hint = notificationsBlocked
    ? 'Notifications are disabled in system settings.'
    : 'Get agent alerts even when the app is closed. Delivered through Orca’s push service and Apple or Google.'

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{
        paddingTop: insets.top + spacing.sm,
        paddingBottom: insets.bottom + spacing.xl
      }}
    >
      <View style={styles.topRow}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>Notifications</Text>
      </View>

      <View style={styles.section}>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Enable notifications</Text>
          <Switch
            accessibilityLabel="Enable notifications"
            value={switchEnabled}
            disabled={notificationsBlocked || saving}
            onValueChange={(v) => void togglePush(v)}
            trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
            thumbColor={colors.textPrimary}
          />
        </View>
        <Text style={styles.hint}>{hint}</Text>
        {notificationsBlocked && (
          <Pressable
            style={({ pressed }) => [
              styles.settingsButton,
              pressed && styles.settingsButtonPressed
            ]}
            onPress={() => void Linking.openSettings()}
          >
            <Text style={styles.settingsButtonText}>Open Settings</Text>
          </Pressable>
        )}
      </View>

      <NotificationDeliverySection
        value={delivery}
        disabled={saving || !switchEnabled}
        onChange={(value) => void changeDelivery(value)}
      />
      {remotePushSupport.resolved && !remotePushSupport.supported && (
        <Text style={styles.hint}>
          Pair an updated desktop to receive alerts when the app is closed.
        </Text>
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
    padding: spacing.lg
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.xl
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm
  },
  heading: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary
  },
  section: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden'
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowLabel: {
    flex: 1,
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  hint: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    lineHeight: 18,
    paddingHorizontal: spacing.md + 2,
    paddingBottom: spacing.md
  },
  settingsButton: {
    alignSelf: 'flex-start',
    marginHorizontal: spacing.md + 2,
    marginBottom: spacing.md,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: 8,
    backgroundColor: colors.bgRaised
  },
  settingsButtonPressed: {
    opacity: 0.6
  },
  settingsButtonText: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  }
})
