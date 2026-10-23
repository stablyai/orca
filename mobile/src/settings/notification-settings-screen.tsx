import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import { ActivityIndicator, AppState, StyleSheet, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import type { NotificationSettingsOperations } from './notification-settings-operations'
import { colors, spacing } from '../theme/mobile-theme'
import type { NotificationPermissionState } from '../notifications/notification-permissions'
import { Banner } from '../components/ui/Banner'
import { ListRow } from '../components/ui/ListRow'
import { MobileSwitch } from '../components/MobileSwitch'
import { triggerSelection } from '../platform/haptics'
import { SettingsScreen, SettingsSection } from './settings-screen-frame'

const DEFAULT_PERMISSION_STATE: NotificationPermissionState = {
  granted: false,
  status: 'undetermined',
  canAskAgain: true,
  authorizationReflectsUserChoice: false
}

export default function NotificationsScreen({
  operations,
  onBack,
  description,
  children
}: {
  operations: NotificationSettingsOperations
  onBack: () => void
  description?: string
  children?: (enabled: boolean) => ReactNode
}) {
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const requestRevision = useRef(0)
  const [error, setError] = useState<string | null>(null)
  const [pushEnabled, setPushEnabled] = useState(false)
  const [permissionState, setPermissionState] = useState(DEFAULT_PERMISSION_STATE)
  // The defaults above read as Off; until a read settles the switch is masked so it never flips by itself.
  const [settled, setSettled] = useState(false)

  const refreshSettings = useCallback(async () => {
    if (savingRef.current) {
      return
    }
    const revision = ++requestRevision.current
    try {
      const [enabled, permission] = await Promise.all([
        operations.preference(),
        operations.permission()
      ])
      if (revision === requestRevision.current) {
        setPushEnabled(enabled.enabled)
        setPermissionState(permission)
        setError(null)
        setSettled(true)
      }
    } catch {
      if (revision === requestRevision.current) {
        setError('Could not load notification settings. Try again.')
        setSettled(true)
      }
    }
  }, [operations])

  useFocusEffect(
    useCallback(() => {
      void refreshSettings()
      return () => {
        requestRevision.current += 1
      }
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
    if (savingRef.current) {
      return
    }
    savingRef.current = true
    requestRevision.current += 1
    setError(null)
    setSettled(true)
    setSaving(true)
    try {
      const permission = await operations.permission(value)
      setPermissionState(permission)
      const saved = await operations.preference(value && permission.granted)
      setPushEnabled(saved.enabled)
    } catch {
      setError('Could not save notification settings. Try again.')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const switchEnabled = pushEnabled && permissionState.granted
  const notificationsBlocked = permissionState.status === 'denied'
  const footer =
    description ?? 'Get notified on this device when an agent needs your input or finishes a task.'
  const openSettings = () =>
    void operations
      .openSettings()
      .catch(() => setError('Could not open system settings. Try again.'))

  return (
    <SettingsScreen title="Notifications" onBack={onBack}>
      {error ? (
        <View style={styles.banner}>
          <Banner tone="error" message={error} />
        </View>
      ) : null}
      {notificationsBlocked ? (
        <View style={styles.banner}>
          <Banner
            tone="warning"
            title="Notifications are off"
            message="Notifications are disabled in system settings. Turn them on for Orca to get alerts."
            action={{ label: 'Open Settings', onPress: openSettings }}
            testID="notification-system-settings"
          />
        </View>
      ) : null}
      <SettingsSection footer={footer}>
        <ListRow
          title="Enable notifications"
          accessory={
            <View>
              <View style={settled ? undefined : styles.masked}>
                <MobileSwitch
                  value={switchEnabled}
                  testID="notification-enabled"
                  accessibilityLabel="Enable notifications"
                  disabled={notificationsBlocked || saving}
                  onValueChange={(v) => {
                    triggerSelection()
                    void togglePush(v)
                  }}
                />
              </View>
              {settled ? null : (
                <View pointerEvents="none" style={styles.spinner}>
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                </View>
              )}
            </View>
          }
        />
      </SettingsSection>
      {children?.(switchEnabled && !saving)}
    </SettingsScreen>
  )
}

const styles = StyleSheet.create({
  banner: { marginTop: spacing.md },
  masked: { opacity: 0 },
  spinner: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' }
})
