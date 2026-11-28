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
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { composerInputStylesSheet as stylesSheet } from './composer-input-styles'
import { useThemedStyles } from '../../theme/themed-styles'

type TextFieldProps = Omit<TextInputProps, 'style' | 'placeholderTextColor' | 'selectionColor'> & {
  inputRef?: Ref<TextInputInstance>
  /** An icon before the text, e.g. Search. */
  leading?: ReactNode
  /** A control after the text, e.g. a clear chip. */
  trailing?: ReactNode
  /** A label before the text, where a ListRow's title sits, for a field among other rows. */
  label?: string
  monospace?: boolean
  style?: StyleProp<ViewStyle>
}

// One line of text as a row of a grouped list; on its own it is a group of one.
export function TextField({
  inputRef,
  leading,
  trailing,
  label,
  monospace = false,
  style,
  editable = true,
  ...inputProps
}: TextFieldProps): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  const colors = useMobileColors()
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
  return (
    <View
      style={[
        styles.field,
        label ? styles.labelledField : null,
        !editable && styles.disabled,
        style
      ]}
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
        <View pointerEvents="none">
          <Text style={styles.fieldLabel} numberOfLines={1}>
            {label}
          </Text>
        </View>
      ) : null}
      <TextInput
        ref={bindInputRef}
        editable={editable}
        placeholderTextColor={colors.textMuted}
        selectionColor={colors.accentBlue}
        style={[styles.fieldText, monospace && styles.mono]}
        accessibilityLabel={label}
        {...inputProps}
      />
      {trailing}
    </View>
  )
}
