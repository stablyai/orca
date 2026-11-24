import { useCallback, useRef, type ReactNode, type Ref } from 'react'
import {
  Pressable,
  StyleSheet,
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
  const ownInputRef = useRef<TextInputInstance>(null)
  const bindInputRef = useCallback(
    (node: TextInputInstance | null) => {
      ownInputRef.current = node
      if (typeof inputRef === 'function') {
        return inputRef(node)
      }
      if (inputRef) {
        inputRef.current = node
      }
      return undefined
    },
    [inputRef]
  )
  const input = (
    <TextInput
      ref={bindInputRef}
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
      {editable ? (
        <Pressable
          accessible={false}
          focusable={false}
          tabIndex={-1}
          onPress={() => ownInputRef.current?.focus()}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      {leading != null ? <View pointerEvents="none">{leading}</View> : null}
      {label ? (
        <View style={styles.labelledText} pointerEvents="box-none">
          <View pointerEvents="none">
            <Text style={styles.fieldLabel} numberOfLines={1}>
              {label}
            </Text>
          </View>
          {input}
        </View>
      ) : (
        input
      )}
      {trailing}
    </View>
  )
}
