import type { ReactNode, Ref } from 'react'
import {
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputInstance,
  type TextInputProps,
  type ViewStyle
} from 'react-native'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { composerInputStyles as styles } from './composer-input-styles'
import { useInputFocus } from './use-input-focus'

type TextFieldProps = Omit<TextInputProps, 'style' | 'placeholderTextColor' | 'selectionColor'> & {
  inputRef?: Ref<TextInputInstance>
  /** An icon before the text, e.g. Search. */
  leading?: ReactNode
  /** A control after the text, e.g. a clear chip. */
  trailing?: ReactNode
  /** A caption that stays above the text, e.g. what the field types into. */
  label?: string
  monospace?: boolean
  style?: StyleProp<ViewStyle>
}

// One line of text on the chat composer's surface.
export function TextField({
  inputRef,
  leading,
  trailing,
  label,
  monospace = false,
  style,
  editable = true,
  onFocus,
  onBlur,
  ...inputProps
}: TextFieldProps): React.JSX.Element {
  useMobileColorScheme()
  const focus = useInputFocus({ onFocus, onBlur })
  const input = (
    <TextInput
      ref={inputRef}
      editable={editable}
      placeholderTextColor={colors.textMuted}
      selectionColor={colors.accentBlue}
      style={[styles.fieldText, monospace && styles.mono]}
      {...inputProps}
      onFocus={focus.onFocus}
      onBlur={focus.onBlur}
    />
  )
  return (
    <View
      style={[styles.field, focus.focused && styles.focused, !editable && styles.disabled, style]}
    >
      {leading}
      {label ? (
        <View style={styles.labelledText}>
          <Text style={styles.fieldLabel} numberOfLines={1}>
            {label}
          </Text>
          {input}
        </View>
      ) : (
        input
      )}
      {trailing}
    </View>
  )
}
