import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Pressable, Switch, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { LiveAlertsCapabilities, LiveAlertsNativeAdapter } from './live-alert-types'
import { liveAlertsNative } from './live-alerts-native'
import {
  DEFAULT_LIVE_ALERTS_PREFERENCES,
  loadLiveAlertsPreferences,
  saveLiveAlertsPreferences,
  type LiveAlertsPreferences
} from './live-alerts-preferences'

/** Android 16+ only: the user turned Orca's Live Updates off in system settings. */
function promotionBlocked(capabilities: LiveAlertsCapabilities | null): boolean {
  if (!capabilities?.notificationsEnabled || !capabilities.promotionApi) {
    return false
  }
  return !capabilities.canPostPromoted
}

type SettingRowProps = {
  label: string
  hint: string
  value: boolean
  disabled: boolean
  testID: string
  onChange: (value: boolean) => void
}

function SettingRow({ label, hint, value, disabled, testID, onChange }: SettingRowProps) {
  return (
    <View style={[styles.row, disabled && styles.disabled]}>
      <View style={styles.labelGroup}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.hint}>{hint}</Text>
      </View>
      <Switch
        accessibilityLabel={label}
        testID={testID}
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
        thumbColor={colors.textPrimary}
      />
    </View>
  )
}

type SettingsNoticeProps = {
  text: string
  action: string
  testID: string
  onPress: () => void
}

function SettingsNotice({ text, action, testID, onPress }: SettingsNoticeProps) {
  return (
    <View style={styles.notice}>
      <Text style={styles.noticeText}>{text}</Text>
      <Pressable
        accessibilityRole="button"
        testID={testID}
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        onPress={onPress}
      >
        <Text style={styles.buttonText}>{action}</Text>
      </Pressable>
    </View>
  )
}

function LiveAlertsSettingsPanel({ native }: { native: LiveAlertsNativeAdapter }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [preferences, setPreferences] = useState(DEFAULT_LIVE_ALERTS_PREFERENCES)
  const [loaded, setLoaded] = useState(false)
  const [capabilities, setCapabilities] = useState(() => native.capabilities())
  const saving = useRef(false)

  const refresh = useCallback(() => {
    setCapabilities(native.capabilities())
    void loadLiveAlertsPreferences().then((value) => {
      if (!saving.current) {
        setPreferences(value)
      }
      setLoaded(true)
    })
  }, [native])

  // Permissions and Live Update access change in system settings; re-read on return.
  useEffect(() => {
    refresh()
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        refresh()
      }
    })
    return () => subscription.remove()
  }, [refresh])

  const change = async (next: LiveAlertsPreferences) => {
    if (saving.current) {
      return
    }
    saving.current = true
    setPreferences(next)
    try {
      await saveLiveAlertsPreferences(next)
    } catch {
      // The switch keeps the user's choice; the next load shows what was stored.
    } finally {
      saving.current = false
    }
  }

  const title = t('liveAlerts.settings.title', 'Live agent status')
  const notificationsOff = capabilities?.notificationsEnabled === false
  return (
    <>
      <Text style={styles.heading}>{title}</Text>
      <View style={styles.section}>
        <SettingRow
          label={title}
          hint={t(
            'liveAlerts.settings.hint',
            'Show an ongoing notification and status-bar chip while agents run.'
          )}
          value={preferences.enabled}
          disabled={!loaded}
          testID="live-alerts-enabled"
          onChange={(enabled) => void change({ ...preferences, enabled })}
        />
      </View>
      {notificationsOff && (
        <SettingsNotice
          text={t('liveAlerts.settings.notificationsOff', 'Notifications are off for Orca')}
          action={t('liveAlerts.settings.notificationSettings', 'Notification settings')}
          testID="live-alerts-notifications-settings"
          onPress={() => native.openAppNotificationSettings()}
        />
      )}
      {promotionBlocked(capabilities) && (
        <SettingsNotice
          text={t('liveAlerts.settings.promotionOff', 'Live Updates are off for Orca')}
          action={t('liveAlerts.settings.allowLiveUpdates', 'Allow Live Updates')}
          testID="live-alerts-promotion-settings"
          onPress={() => native.openPromotionSettings()}
        />
      )}
      <SettingsNotice
        text={t(
          'liveAlerts.settings.batteryHint',
          'Some phones pause apps in the background. Set Orca’s battery usage to Unrestricted so the status keeps updating.'
        )}
        action={t('liveAlerts.settings.batterySettings', 'Battery settings')}
        testID="live-alerts-battery-settings"
        onPress={() => native.openAppDetailsSettings()}
      />
    </>
  )
}

/** The live agent status settings: Android only, and only in builds with the native module. */
export function LiveAlertsSettingsSection() {
  return liveAlertsNative ? <LiveAlertsSettingsPanel native={liveAlertsNative} /> : null
}

const styles = themedStyleSheet(() => ({
  heading: {
    fontSize: typography.metaSize,
    fontWeight: '600',
    color: colors.textSecondary,
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.sm
  },
  section: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    overflow: 'hidden'
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md },
  labelGroup: { flex: 1, gap: spacing.xs },
  label: { fontSize: typography.bodySize, fontWeight: '500', color: colors.textPrimary },
  hint: { fontSize: typography.metaSize, color: colors.textMuted },
  disabled: { opacity: 0.5 },
  notice: { marginTop: spacing.md, paddingHorizontal: spacing.sm, gap: spacing.sm },
  noticeText: { fontSize: typography.metaSize, color: colors.textMuted, lineHeight: 18 },
  button: {
    alignSelf: 'flex-start',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  buttonPressed: { opacity: 0.6 },
  buttonText: { color: colors.textPrimary, fontSize: typography.metaSize, fontWeight: '600' }
}))
