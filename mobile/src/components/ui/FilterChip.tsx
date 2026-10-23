import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronDown, type LucideIcon } from 'lucide-react-native'
import { colors, MIN_TOUCH_TARGET, radii, textStyles } from '../../theme/mobile-theme'
import { pressTransition } from './transition-styles'

type FilterChipProps = {
  label: string
  onPress: () => void
  /** On: a filter is applied, or the chip is the picked option. */
  active?: boolean
  icon?: LucideIcon
  /** Draws a chevron: the chip opens a menu or sheet. */
  menu?: boolean
  disabled?: boolean
  accessibilityLabel?: string
  testID?: string
}

/** A 32 pt capsule inside a 44 pt touch box, for filters, scopes and menu triggers in toolbars. */
export function FilterChip({
  label,
  onPress,
  active = false,
  icon: Icon,
  menu = false,
  disabled = false,
  accessibilityLabel,
  testID
}: FilterChipProps) {
  const color = active ? colors.textPrimary : colors.textSecondary
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled, selected: active }}
      testID={testID}
      style={[styles.touch, disabled && styles.disabled]}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.chip,
            Icon && styles.withIcon,
            menu && styles.withMenu,
            active ? styles.active : styles.idle,
            pressed && styles.pressed,
            pressed ? pressTransition.pressed : pressTransition.rest
          ]}
        >
          {Icon ? <Icon size={15} color={color} strokeWidth={2.2} /> : null}
          <Text style={[styles.label, { color }]} numberOfLines={1}>
            {label}
          </Text>
          {menu ? <ChevronDown size={14} color={colors.textMuted} strokeWidth={2.2} /> : null}
        </View>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  touch: { minHeight: MIN_TOUCH_TARGET, justifyContent: 'center' },
  disabled: { opacity: 0.4 },
  chip: {
    height: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 13,
    borderRadius: radii.pill,
    borderWidth: 1
  },
  withIcon: { paddingLeft: 9 },
  withMenu: { paddingRight: 9 },
  idle: { backgroundColor: colors.fill, borderColor: 'transparent' },
  active: { backgroundColor: colors.fillPressed, borderColor: colors.fieldBorderFocused },
  pressed: { transform: [{ scale: 0.96 }] },
  label: { ...textStyles.subhead, fontWeight: '500' }
})
