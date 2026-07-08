import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native'
import type { ReactNode } from 'react'
import { radii, type ThemeColors } from '../theme/mobile-theme'
import { useThemedStyles } from '../theme/theme-context'

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
  const styles = useThemedStyles(createStyles)
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

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
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
  })
