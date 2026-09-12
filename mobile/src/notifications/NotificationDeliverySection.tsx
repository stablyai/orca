import { StyleSheet, Switch, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { NotificationDeliveryPreferences } from './notification-delivery-preferences'

type Props = {
  value: NotificationDeliveryPreferences
  disabled?: boolean
  onChange: (value: NotificationDeliveryPreferences) => void
}

export function NotificationDeliverySection({ value, disabled, onChange }: Props) {
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
          'Only when away from desktop',
          'After 3 minutes without keyboard or mouse activity, or when locked.'
        )}
        {row('sound', 'Notification sound')}
        {row(
          'suppressWhileViewing',
          'Suppress while focused',
          'Skip alerts for this workspace only while Orca is open.'
        )}
      </View>
      <Text style={styles.footer}>
        Alert types follow each paired desktop’s notification settings. Notifications pause after 7
        days without using this app; open it and reconnect to resume.
      </Text>
    </>
  )
}

const styles = StyleSheet.create({
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
})
