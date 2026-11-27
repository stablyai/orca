import { Pressable, Text } from 'react-native'
import { pressedStyle } from '../theme/mobile-theme'
import { sheetStylesSheet } from './mobile-bot-sheet-styles'
import { useThemedStyles } from '../theme/themed-styles'

const TEXT_BUTTON_HIT_SLOP = { top: 8, bottom: 8 }

/** A row's quiet text action: 32 pt tall plus 8 pt above and below, like MobileStateButton; none sideways, where these sit 4 pt apart. */
export function MobileBotTextButton(props: {
  label: string
  onPress: () => void
  disabled?: boolean
  accessibilityLabel?: string
  /** In the accent, for the one action a line offers (Retry, Undo). */
  accent?: boolean
}) {
  const sheetStyles = useThemedStyles(sheetStylesSheet)
  return (
    <Pressable
      style={({ pressed }) => [
        sheetStyles.textButton,
        pressed && pressedStyle,
        props.disabled && sheetStyles.textButtonDisabled
      ]}
      onPress={props.onPress}
      disabled={props.disabled}
      hitSlop={TEXT_BUTTON_HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ disabled: props.disabled === true }}
    >
      <Text style={[sheetStyles.textButtonLabel, props.accent && sheetStyles.textButtonAccent]}>
        {props.label}
      </Text>
    </Pressable>
  )
}
