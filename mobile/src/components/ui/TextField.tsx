import { forwardRef, useState } from 'react'
import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native'
import { colors, motion, radii, spacing, textStyles } from '../../theme/mobile-theme'
import { TEXT_INPUT_FONT_SIZE } from '../../platform/text-input-font-size'

type TextFieldProps = Omit<TextInputProps, 'style' | 'placeholderTextColor' | 'selectionColor'> & {
  /** Shown above the field; also its accessibility label when none is given. */
  label?: string
  /** One line under the field: a hint, or the error when `error` is set. */
  footnote?: string
  error?: boolean
}

/** A single-line form field: 48 pt, the composer's fill and edge, 16 pt text, a brighter edge on focus. */
export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  {
    label,
    footnote,
    error = false,
    editable = true,
    onFocus,
    onBlur,
    accessibilityLabel,
    ...input
  },
  ref
) {
  const [focused, setFocused] = useState(false)
  return (
    <View style={styles.root}>
      {label !== undefined ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput
        ref={ref}
        {...input}
        editable={editable}
        accessibilityLabel={accessibilityLabel ?? label}
        placeholderTextColor={colors.textMuted}
        selectionColor={colors.accentBlue}
        onFocus={(event) => {
          setFocused(true)
          onFocus?.(event)
        }}
        onBlur={(event) => {
          setFocused(false)
          onBlur?.(event)
        }}
        style={[
          styles.input,
          focused && styles.focused,
          error && styles.errored,
          !editable && styles.disabled
        ]}
      />
      {footnote !== undefined ? (
        <Text style={[styles.footnote, error && styles.footnoteError]}>{footnote}</Text>
      ) : null}
    </View>
  )
})

const styles = StyleSheet.create({
  root: { gap: spacing.sm },
  label: { ...textStyles.footnote, fontWeight: '500', color: colors.textSecondary, paddingLeft: 4 },
  input: {
    ...textStyles.body,
    fontSize: TEXT_INPUT_FONT_SIZE,
    height: 48,
    paddingHorizontal: 14,
    paddingVertical: 0,
    borderRadius: radii.field,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    backgroundColor: colors.fieldFill,
    color: colors.textPrimary
  },
  focused: { borderColor: colors.fieldBorderFocused },
  errored: { borderColor: colors.danger },
  disabled: { opacity: motion.disabledOpacity },
  footnote: { ...textStyles.footnote, color: colors.textMuted, paddingLeft: 4 },
  footnoteError: { color: colors.danger }
})
