import type { Ref } from 'react'
import {
  TextInput,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type TextInputInstance
} from 'react-native'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { composerInputStylesSheet as stylesSheet } from './composer-input-styles'
import { useThemedStyles } from '../../theme/themed-styles'

type FieldTextInputProps = Omit<
  TextInputProps,
  'style' | 'placeholderTextColor' | 'selectionColor'
> & {
  ref?: Ref<TextInputInstance>
  /** Size, padding and type; the fill and radius are the field's own. */
  style?: StyleProp<TextStyle>
}

// A field drawn on the TextInput itself, for boxes that set their own size.
export function FieldTextInput({ style, ...inputProps }: FieldTextInputProps): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  const colors = useMobileColors()
  return (
    <TextInput
      placeholderTextColor={colors.textMuted}
      selectionColor={colors.accentBlue}
      {...inputProps}
      style={[styles.fieldInput, style]}
    />
  )
}
