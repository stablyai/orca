import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { Pressable, Text } from 'react-native'
import { pressedStyle } from '../theme/mobile-theme'
import { sheetStyles } from './mobile-bot-sheet-styles'

/** A row's quiet text action; 32 pt tall with an 8 pt slop, the touch target of MobileStateButton. */
export function MobileBotTextButton(props: {
  label: string
  onPress: () => void
  disabled?: boolean
  accessibilityLabel?: string
}) {
  useMobileColorScheme()
  return (
    <Pressable
      style={({ pressed }) => [
        sheetStyles.textButton,
        pressed && pressedStyle,
        props.disabled && sheetStyles.textButtonDisabled
      ]}
      onPress={props.onPress}
      disabled={props.disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ disabled: props.disabled === true }}
    >
      <Text style={sheetStyles.textButtonLabel}>{props.label}</Text>
    </Pressable>
  )
}
