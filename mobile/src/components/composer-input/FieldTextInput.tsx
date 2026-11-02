import type { Ref } from 'react'
import { TextInput, type StyleProp, type TextInputProps, type TextStyle } from 'react-native'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { composerInputStyles as styles } from './composer-input-styles'
import { useInputFocus } from './use-input-focus'

type FieldTextInputProps = Omit<
  TextInputProps,
  'style' | 'placeholderTextColor' | 'selectionColor'
> & {
  ref?: Ref<TextInput>
  /** Size, padding and type; the edge and focus ring are the field's own. */
  style?: StyleProp<TextStyle>
}

// A field drawn on the TextInput itself, for boxes that set their own size.
export function FieldTextInput({
  style,
  onFocus,
  onBlur,
  ...inputProps
}: FieldTextInputProps): React.JSX.Element {
  useMobileColorScheme()
  const focus = useInputFocus({ onFocus, onBlur })
  return (
    <TextInput
      placeholderTextColor={colors.textMuted}
      selectionColor={colors.accentBlue}
      {...inputProps}
      onFocus={focus.onFocus}
      onBlur={focus.onBlur}
      style={[styles.fieldInput, style, focus.focused && styles.focused]}
    />
  )
}
