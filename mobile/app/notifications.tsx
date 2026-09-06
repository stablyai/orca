import { useState, useCallback, useEffect } from 'react'
import { AppState, Linking, View, Text, StyleSheet, Pressable, Switch } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter, useFocusEffect } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import { colors, spacing, typography } from '../src/theme/mobile-theme'
import {
  loadPushNotificationsEnabled,
  loadRemotePushAgentStates,
  loadRemotePushEnabled,
  savePushNotificationsEnabled,
  type RemotePushAgentState
} from '../src/storage/preferences'
import { BackgroundNotificationsSection } from '../src/notifications/BackgroundNotificationsSection'
import {
  setRemotePushAgentStates,
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
  const [backgroundEnabled, setBackgroundEnabled] = useState(false)
  const [agentStates, setAgentStates] = useState<readonly RemotePushAgentState[]>([])
  const remotePushSupport = useRemotePushCapableHosts()

  const refreshSettings = useCallback(async () => {
    const [enabled, permission, background, states] = await Promise.all([
      loadPushNotificationsEnabled(),
      getNotificationPermissionState(),
      loadRemotePushEnabled(),
      loadRemotePushAgentStates()
    ])
    setPushEnabled(enabled)
    setPermissionState(permission)
    setBackgroundEnabled(background)
    setAgentStates(states)
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
    if (value) {
      const granted = await ensureNotificationPermissions()
      const permission = await getNotificationPermissionState()
      setPermissionState(permission)
      if (!granted) {
        setPushEnabled(false)
        await savePushNotificationsEnabled(false)
        return
      }
    }
    setPushEnabled(value)
    await savePushNotificationsEnabled(value)
  }

  const toggleBackground = async (value: boolean) => {
    if (value) {
      const granted = await ensureNotificationPermissions()
      setPermissionState(await getNotificationPermissionState())
      if (!granted) {
        return
      }
    }
    setBackgroundEnabled(value)
    await setRemotePushEnabled(value)
  }

  const toggleAgentState = async (state: RemotePushAgentState, value: boolean) => {
    const next = value
      ? [...new Set([...agentStates, state])]
      : agentStates.filter((existing) => existing !== state)
    setAgentStates(next)
    await setRemotePushAgentStates(next)
  }

  const switchEnabled = pushEnabled && permissionState.granted
  const notificationsBlocked = permissionState.status === 'denied'
  const hint = notificationsBlocked
    ? 'Notifications are disabled in system settings.'
    : 'Get notified on this device when an agent needs your input or finishes a task.'

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>Notifications</Text>
      </View>

      <View style={styles.section}>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Agent notifications</Text>
          <Switch
            value={switchEnabled}
            disabled={notificationsBlocked}
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

      <BackgroundNotificationsSection
        supported={remotePushSupport.supported}
        resolved={remotePushSupport.resolved}
        enabled={backgroundEnabled}
        agentStates={agentStates}
        onToggleEnabled={(value) => void toggleBackground(value)}
        onToggleAgentState={(state, value) => void toggleAgentState(state, value)}
      />
    </View>
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
