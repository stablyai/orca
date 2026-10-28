import type { ComponentType } from 'react'
import { Pressable } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { styles } from './mobile-session-styles'

type HeaderIconProps = {
  size?: number
  color?: string
  strokeWidth?: number
}

type MobileSessionHeaderIconButtonProps = {
  active?: boolean
  disabled?: boolean
  accessibilityLabel: string
  iconColor?: string
  icon: ComponentType<HeaderIconProps>
  onPress: () => void
}

export function MobileSessionHeaderIconButton({
  active = false,
  disabled = false,
  accessibilityLabel,
  icon: Icon,
  iconColor,
  onPress
}: MobileSessionHeaderIconButtonProps) {
  useMobileColorScheme()
  return (
    <Pressable
      style={({ pressed }) => [
        styles.headerButton,
        pressed && styles.headerButtonPressed,
        active && styles.headerButtonActive,
        disabled && styles.headerButtonDisabled
      ]}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <Icon size={18} color={iconColor ?? colors.textSecondary} strokeWidth={2.1} />
    </Pressable>
  )
}
