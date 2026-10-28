import { Pressable, type StyleProp, type ViewStyle } from 'react-native'
import type { ReactNode } from 'react'
import { colors, radii } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

type Props = {
  children: ReactNode
  disabled?: boolean
  label: string
  onPress: () => void
  style?: StyleProp<ViewStyle>
}

export function MobileBrowserToolbarIconButton({
  children,
  disabled,
  label,
  onPress,
  style
}: Props): React.JSX.Element {
  useMobileColorScheme()
  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        style,
        pressed && !disabled && styles.buttonPressed,
        disabled && styles.disabled
      ]}
      disabled={disabled}
      onPress={onPress}
      accessibilityLabel={label}
    >
      {children}
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  button: {
    width: 26,
    height: 26,
    borderRadius: radii.button,
    alignItems: 'center',
    justifyContent: 'center'
  },
  buttonPressed: {
    backgroundColor: colors.bgRaised
  },
  disabled: {
    opacity: 0.35
  }
}))
