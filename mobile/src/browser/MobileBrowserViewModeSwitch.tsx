import { Pressable, StyleSheet, View } from 'react-native'
import { Monitor, Smartphone, type LucideIcon } from 'lucide-react-native'
import { colors, radii } from '../theme/mobile-theme'
import type { MobileBrowserViewMode } from './browser-screencast-request'

type Props = {
  disabled: boolean
  value: MobileBrowserViewMode
  onChange: (mode: MobileBrowserViewMode) => void
}

const VIEW_MODES: { id: MobileBrowserViewMode; label: string; icon: LucideIcon }[] = [
  { id: 'web', label: 'Web', icon: Monitor },
  { id: 'mobile', label: 'Mobile', icon: Smartphone }
]

export function MobileBrowserViewModeSwitch({
  disabled,
  value,
  onChange
}: Props): React.JSX.Element {
  return (
    <View style={styles.switch}>
      {VIEW_MODES.map((mode) => (
        <ViewModeButton
          key={mode.id}
          Icon={mode.icon}
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
  Icon,
  disabled,
  label,
  onPress,
  selected
}: {
  Icon: LucideIcon
  disabled?: boolean
  label: string
  onPress: () => void
  selected: boolean
}) {
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
      <Icon size={14} color={selected ? colors.bgBase : colors.textSecondary} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
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
    width: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button
  },
  buttonPressed: {
    backgroundColor: colors.borderSubtle
  },
  buttonSelected: {
    backgroundColor: colors.textPrimary
  },
  disabled: {
    opacity: 0.35
  }
})
