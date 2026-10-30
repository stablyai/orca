import type { ReactNode, RefObject } from 'react'
import { TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { composerInputStyles as styles } from './composer-input-styles'

type TextFieldProps = Omit<TextInputProps, 'style' | 'placeholderTextColor' | 'selectionColor'> & {
  inputRef?: RefObject<TextInput | null>
  /** An icon before the text, e.g. Search. */
  leading?: ReactNode
  /** A control after the text, e.g. a clear chip. */
  trailing?: ReactNode
  monospace?: boolean
  style?: StyleProp<ViewStyle>
}

// One line of text on the chat composer's surface.
export function TextField({
  inputRef,
  leading,
  trailing,
  monospace = false,
  style,
  editable = true,
  ...inputProps
}: TextFieldProps): React.JSX.Element {
  useMobileColorScheme()
  return (
    <View style={[styles.field, !editable && styles.disabled, style]}>
      {leading}
      <TextInput
        ref={inputRef}
        editable={editable}
        placeholderTextColor={colors.textMuted}
        selectionColor={colors.accentBlue}
        style={[styles.fieldText, monospace && styles.mono]}
        {...inputProps}
      />
      {trailing}
    </View>
  )
}
