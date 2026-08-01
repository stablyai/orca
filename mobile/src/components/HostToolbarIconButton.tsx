import type { ReactNode } from 'react'
import { Pressable, type StyleProp, type ViewStyle } from 'react-native'

export function HostToolbarIconButton({
  accessibilityLabel,
  children,
  disabled,
  disabledStyle,
  onPress,
  style
}: {
  accessibilityLabel: string
  children: ReactNode
  disabled: boolean
  disabledStyle?: StyleProp<ViewStyle>
  onPress: () => void
  style: StyleProp<ViewStyle>
}): React.JSX.Element {
  return (
    <Pressable
      style={[style, disabled && disabledStyle]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      {children}
    </Pressable>
  )
}
