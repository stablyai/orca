import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { Pressable, Text } from 'react-native'
import { sheetStyles } from './mobile-bot-sheet-styles'
import { optionStyles } from './mobile-bot-option-styles'

/** A row's quiet text action, like the option sheet's Clear filters. */
export function MobileBotTextButton(props: {
  label: string
  onPress: () => void
  disabled?: boolean
  accessibilityLabel?: string
}) {
  useMobileColorScheme()
  return (
    <Pressable
      style={[sheetStyles.textButton, props.disabled && optionStyles.optionRowDisabled]}
      onPress={props.onPress}
      disabled={props.disabled}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
    >
      <Text style={sheetStyles.textButtonLabel}>{props.label}</Text>
    </Pressable>
  )
}
