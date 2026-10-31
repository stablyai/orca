import type { ComponentType } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronDown } from 'lucide-react-native'
import { colors, radii } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

type IconProps = { size?: number; color?: string; strokeWidth?: number }

type FilterChipProps = {
  label: string
  onPress: () => void
  /** A filter is applied, or the chip is the picked option. */
  active?: boolean
  icon?: ComponentType<IconProps>
  /** Draws a chevron: the chip opens a menu or sheet. */
  menu?: boolean
  disabled?: boolean
  accessibilityLabel?: string
}

// A 32 pt pill inside a 44 pt touch box, for filters, scopes and menu triggers in a toolbar row.
// Chips share a row's spare width when they fit; once the row scrolls they keep their own size.
export function FilterChip({
  label,
  onPress,
  active = false,
  icon: Icon,
  menu = false,
  disabled = false,
  accessibilityLabel
}: FilterChipProps) {
  useMobileColorScheme()
  const color = active ? colors.textPrimary : colors.textSecondary
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled, selected: active }}
      style={[styles.touch, disabled && styles.disabled]}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.chip,
            Icon && styles.withIcon,
            menu && styles.withMenu,
            active && styles.active,
            pressed && styles.pressed
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

const styles = themedStyleSheet(() => ({
  touch: {
    flexGrow: 1,
    minHeight: 44,
    justifyContent: 'center'
  },
  disabled: {
    opacity: 0.4
  },
  chip: {
    height: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: 13,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: colors.bgRaised
  },
  withIcon: {
    paddingLeft: 9
  },
  withMenu: {
    paddingRight: 9
  },
  active: {
    borderColor: colors.textSecondary
  },
  pressed: {
    opacity: 0.75
  },
  label: {
    fontSize: 14,
    fontWeight: '500'
  }
}))
