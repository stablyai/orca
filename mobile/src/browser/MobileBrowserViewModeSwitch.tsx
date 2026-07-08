import { Pressable, StyleSheet, Text, View } from 'react-native'
import { radii, spacing, type ThemeColors } from '../theme/mobile-theme'
import type { MobileBrowserViewMode } from './browser-screencast-request'
import { useThemedStyles } from '../theme/theme-context'

type Props = {
  disabled: boolean
  value: MobileBrowserViewMode
  onChange: (mode: MobileBrowserViewMode) => void
}

const VIEW_MODES: { id: MobileBrowserViewMode; label: string }[] = [
  { id: 'web', label: 'Web' },
  { id: 'mobile', label: 'Mobile' }
]

export function MobileBrowserViewModeSwitch({
  disabled,
  value,
  onChange
}: Props): React.JSX.Element {
  const styles = useThemedStyles(createStyles)
  return (
    <View style={styles.switch}>
      {VIEW_MODES.map((mode) => (
        <ViewModeButton
          key={mode.id}
          label={mode.label}
          selected={value === mode.id}
          disabled={disabled}
          onPress={() => onChange(mode.id)}
        />
      ))}
    </View>
  )
}

function ViewModeButton({
  disabled,
  label,
  onPress,
  selected
}: {
  disabled?: boolean
  label: string
  onPress: () => void
  selected: boolean
}) {
  const styles = useThemedStyles(createStyles)
  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        selected && styles.buttonSelected,
        pressed && !disabled && !selected && styles.buttonPressed,
        disabled && styles.disabled
      ]}
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={`Show ${label.toLowerCase()} website view`}
    >
      <Text style={[styles.buttonText, selected && styles.buttonTextSelected]}>{label}</Text>
    </Pressable>
  )
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    switch: {
      minHeight: 28,
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: radii.input,
      backgroundColor: colors.bgRaised,
      padding: 2
    },
    button: {
      minHeight: 24,
      minWidth: 52,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radii.button,
      paddingHorizontal: spacing.sm
    },
    buttonPressed: {
      backgroundColor: colors.borderSubtle
    },
    buttonSelected: {
      backgroundColor: colors.textPrimary
    },
    buttonText: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: '600'
    },
    buttonTextSelected: {
      color: colors.bgBase
    },
    disabled: {
      opacity: 0.35
    }
  })
