import type { ComponentType } from 'react'
import { Pressable } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { styles } from '../../app/h/[hostId]/session/mobile-session-styles'

type HeaderIconProps = {
  size?: number
  color?: string
  strokeWidth?: number
}

type MobileSessionHeaderIconButtonProps = {
  active?: boolean
  accessibilityLabel: string
  icon: ComponentType<HeaderIconProps>
  onPress: () => void
}

export function MobileSessionHeaderIconButton({
  active = false,
  accessibilityLabel,
  icon: Icon,
  onPress
}: MobileSessionHeaderIconButtonProps) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.filesButton,
        pressed && styles.filesButtonPressed,
        active && styles.filesButtonActive
      ]}
      onPress={onPress}
      hitSlop={8}
      accessibilityLabel={accessibilityLabel}
    >
      <Icon size={18} color={colors.textSecondary} strokeWidth={2.1} />
    </Pressable>
  )
}
