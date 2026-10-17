import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { createThemedStyles } from '../theme/mobile-themed-styles'
import { useMobileTheme } from '../theme/use-mobile-theme'
import { useMobileAppearance } from '../theme/use-mobile-appearance'
import type { MobileAppearance } from '../theme/mobile-appearance-controller'

const choices: { value: MobileAppearance; label: string }[] = [
  { value: 'system', label: 'Follow system' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' }
]

export function MobileAppearanceSettings() {
  useMobileTheme()
  const { preference, setPreference, error } = useMobileAppearance()
  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.heading}>Theme</Text>
        <Text style={styles.description}>Choose an appearance or match your device.</Text>
      </View>
      <View style={styles.section}>
        {choices.map(({ value, label }) => (
          <Pressable
            key={value}
            accessibilityRole="radio"
            accessibilityLabel={label}
            accessibilityState={{ checked: preference === value }}
            onPress={() => void setPreference(value)}
            style={({ pressed }) => [
              styles.segment,
              preference === value && styles.segmentActive,
              pressed && styles.pressed
            ]}
          >
            <Text style={[styles.label, preference === value && styles.labelActive]}>
              {value === 'system' ? 'System' : label}
            </Text>
          </Pressable>
        ))}
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  )
}

const styles = createThemedStyles(() =>
  StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: spacing.sm,
      padding: spacing.md,
      backgroundColor: colors.bgPanel,
      borderRadius: radii.card
    },
    content: { flexGrow: 1, flexShrink: 1, flexBasis: 120, minWidth: 120 },
    heading: {
      color: colors.textPrimary,
      fontSize: typography.bodySize,
      fontWeight: '500'
    },
    description: {
      color: colors.textSecondary,
      fontSize: typography.bodySize - 2,
      marginTop: 2
    },
    section: {
      flexDirection: 'row',
      flexShrink: 0,
      maxWidth: '100%',
      marginLeft: 'auto',
      backgroundColor: colors.bgBase,
      borderRadius: radii.button,
      padding: 2
    },
    segment: {
      flexShrink: 1,
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 36,
      paddingHorizontal: spacing.sm,
      borderRadius: radii.button - 1
    },
    segmentActive: { backgroundColor: colors.bgRaised },
    pressed: { backgroundColor: colors.bgPanel },
    label: { color: colors.textSecondary, fontSize: typography.metaSize, fontWeight: '600' },
    labelActive: { color: colors.textPrimary, fontWeight: '600' },
    error: {
      width: '100%',
      marginTop: spacing.sm,
      fontSize: typography.metaSize,
      color: colors.statusRed
    }
  })
)
