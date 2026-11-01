import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'
import type { NotificationSettingsOperations } from './notification-settings-operations'
import { ListRow } from '../components/list/ListGroup'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { NotificationPermissionState } from '../notifications/notification-permissions'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MobileSwitch } from '../components/MobileSwitch'
import { SettingsNote, SettingsScreen, SettingsSection } from './settings-screen-frame'

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
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const requestRevision = useRef(0)
  const [error, setError] = useState<string | null>(null)
  const [pushEnabled, setPushEnabled] = useState(false)
  const [permissionState, setPermissionState] = useState(DEFAULT_PERMISSION_STATE)

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
      }
    } catch {
      if (revision === requestRevision.current) {
        setError(
          t(
            'settings.notificationSettingsScreen.loadFailed',
            'Could not load notification settings. Try again.'
          )
        )
      }
    }
  }, [operations, t])

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
    setSaving(true)
    try {
      const permission = await operations.permission(value)
      setPermissionState(permission)
      const saved = await operations.preference(value && permission.granted)
      setPushEnabled(saved.enabled)
    } catch {
      setError(
        t(
          'settings.notificationSettingsScreen.saveFailed',
          'Could not save notification settings. Try again.'
        )
      )
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const switchEnabled = pushEnabled && permissionState.granted
  const notificationsBlocked = permissionState.status === 'denied'
  const hint = notificationsBlocked
    ? t(
        'settings.notificationSettingsScreen.notificationsBlocked',
        'Notifications are disabled in system settings.'
      )
    : (description ??
      t(
        'settings.notificationSettingsScreen.description',
        'Get notified on this device when an agent needs your input or finishes a task.'
      ))

  const openSystemSettings = () =>
    void operations
      .openSettings()
      .catch(() =>
        setError(
          t(
            'settings.notificationSettingsScreen.openSettingsFailed',
            'Could not open system settings. Try again.'
          )
        )
      )

  return (
    <SettingsScreen
      title={t('settings.notificationSettingsScreen.title', 'Notifications')}
      onBack={onBack}
    >
      {error ? <SettingsNote error>{error}</SettingsNote> : null}
      <SettingsSection first footer={hint}>
        <ListRow
          key="enabled"
          title={t(
            'settings.notificationSettingsScreen.enableNotifications',
            'Enable notifications'
          )}
          accessory={
            <MobileSwitch
              value={switchEnabled}
              testID="notification-enabled"
              accessibilityLabel={t(
                'settings.notificationSettingsScreen.enableNotifications',
                'Enable notifications'
              )}
              disabled={notificationsBlocked || saving}
              onValueChange={(v) => void togglePush(v)}
            />
          }
        />
        {notificationsBlocked ? (
          <ListRow
            key="systemSettings"
            title={t('settings.notificationSettingsScreen.openSettings', 'Open Settings')}
            testID="notification-system-settings"
            onPress={openSystemSettings}
          />
        ) : null}
      </SettingsSection>
      {children?.(switchEnabled && !saving)}
    </SettingsScreen>
  )
}
