import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import { AppState, View, Text, Pressable, ScrollView } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect } from 'expo-router'
import type { NotificationSettingsOperations } from './notification-settings-operations'
import { ChevronLeft } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { NotificationPermissionState } from '../notifications/notification-permissions'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MobileSwitch } from '../components/MobileSwitch'

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
  const insets = useSafeAreaInsets()
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

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{
        paddingTop: insets.top + spacing.sm,
        paddingBottom: insets.bottom + spacing.xl
      }}
    >
      <View style={styles.topRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.back', 'Back')}
          style={styles.backButton}
          onPress={onBack}
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>
          {t('settings.notificationSettingsScreen.title', 'Notifications')}
        </Text>
      </View>

      {error && (
        <Text accessibilityRole="alert" style={styles.hint}>
          {error}
        </Text>
      )}
      <View style={styles.section}>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>
            {t('settings.notificationSettingsScreen.enableNotifications', 'Enable notifications')}
          </Text>
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
        </View>
        <Text style={styles.hint}>{hint}</Text>
        {notificationsBlocked && (
          <Pressable
            style={({ pressed }) => [
              styles.settingsButton,
              pressed && styles.settingsButtonPressed
            ]}
            testID="notification-system-settings"
            onPress={() =>
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
            }
          >
            <Text style={styles.settingsButtonText}>
              {t('settings.notificationSettingsScreen.openSettings', 'Open Settings')}
            </Text>
          </Pressable>
        )}
      </View>
      {children?.(switchEnabled && !saving)}
    </ScrollView>
  )
}

const styles = themedStyleSheet(() => ({
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
    borderRadius: radii.control,
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
    borderRadius: radii.surface,
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
    borderRadius: radii.control,
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
}))
