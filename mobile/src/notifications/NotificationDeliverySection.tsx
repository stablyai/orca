import { Switch, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { NotificationDeliveryPreferences } from './notification-delivery-preferences'

type Props = {
  value: NotificationDeliveryPreferences
  disabled?: boolean
  onChange: (value: NotificationDeliveryPreferences) => void
}

export function NotificationDeliverySection({ value, disabled, onChange }: Props) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const row = (key: keyof NotificationDeliveryPreferences, label: string, hint?: string) => {
    return (
      <View key={key} style={[styles.row, disabled && styles.disabled]}>
        <View style={styles.labelGroup}>
          <Text style={styles.label}>{label}</Text>
          {hint && <Text style={styles.hint}>{hint}</Text>}
        </View>
        <Switch
          accessibilityLabel={label}
          testID={`notification-${key}`}
          value={value[key]}
          disabled={disabled}
          onValueChange={(enabled) => onChange({ ...value, [key]: enabled })}
          trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
          thumbColor={colors.textPrimary}
        />
      </View>
    )
  }
  return (
    <>
      <View style={styles.section}>
        {row(
          'onlyWhenDesktopAway',
          t(
            'notifications.notificationDeliverySection.onlyWhenAway',
            'Only when away from desktop'
          ),
          t(
            'notifications.notificationDeliverySection.onlyWhenAwayHint',
            'After 3 minutes without keyboard or mouse activity, or when locked.'
          )
        )}
        {row('sound', t('notifications.notificationDeliverySection.sound', 'Notification sound'))}
        {row(
          'suppressWhileViewing',
          t(
            'notifications.notificationDeliverySection.suppressWhileFocused',
            'Suppress while focused'
          ),
          t(
            'notifications.notificationDeliverySection.suppressWhileFocusedHint',
            'Skip alerts for the workspace open on this phone.'
          )
        )}
      </View>
      <Text style={styles.footer}>
        {t(
          'notifications.notificationDeliverySection.footer',
          'Alert types follow each paired desktop’s notification settings. Notifications pause after 7 days without using this app; open it and reconnect to resume.'
        )}
      </Text>
    </>
  )
}

const styles = themedStyleSheet(() => ({
  section: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    overflow: 'hidden',
    marginTop: spacing.md
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md },
  labelGroup: { flex: 1, gap: spacing.xs },
  label: { fontSize: typography.bodySize, fontWeight: '500', color: colors.textPrimary },
  hint: { fontSize: typography.metaSize, color: colors.textMuted },
  disabled: { opacity: 0.5 },
  footer: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    marginTop: spacing.md,
    paddingHorizontal: spacing.sm
  }
}))
