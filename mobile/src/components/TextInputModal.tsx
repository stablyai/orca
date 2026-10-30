import { useState } from 'react'
import { View, Text, Pressable, type KeyboardTypeOptions } from 'react-native'
import { colors, spacing, radii, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { BottomDrawer } from './BottomDrawer'
import { TextField } from './composer-input/TextField'

type Props = {
  visible: boolean
  title: string
  message?: string
  defaultValue?: string
  placeholder?: string
  submitLabel?: string
  selectTextOnFocus?: boolean
  allowEmpty?: boolean
  keyboardType?: KeyboardTypeOptions
  onSubmit: (value: string) => void
  onCancel: () => void
  /** Called once the drawer has gone, which is when the field stops holding the focus. */
  onAfterClose?: () => void
}

export function TextInputModal({
  visible,
  title,
  message,
  defaultValue = '',
  placeholder,
  submitLabel,
  selectTextOnFocus = false,
  allowEmpty = false,
  keyboardType,
  onSubmit,
  onCancel,
  onAfterClose
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [value, setValue] = useState(defaultValue)
  const [previousVisible, setPreviousVisible] = useState(visible)
  const [previousDefaultValue, setPreviousDefaultValue] = useState(defaultValue)

  // Reset before opening commit to prevent previous-value flash; preserve close-animation state.
  const shouldResetValue = visible && (!previousVisible || defaultValue !== previousDefaultValue)
  if (visible !== previousVisible || shouldResetValue) {
    setPreviousVisible(visible)
    if (shouldResetValue) {
      setPreviousDefaultValue(defaultValue)
      setValue(defaultValue)
    }
  }

  function handleSubmit() {
    const trimmed = value.trim()
    if (trimmed || allowEmpty) {
      onSubmit(trimmed)
    }
  }

  const canSubmit = allowEmpty || value.trim().length > 0

  return (
    <BottomDrawer visible={visible} onClose={onCancel} onAfterClose={onAfterClose}>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        {message ? <Text style={styles.message}>{message}</Text> : null}
      </View>

      <TextField
        value={value}
        onChangeText={setValue}
        placeholder={placeholder}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        selectTextOnFocus={selectTextOnFocus}
        keyboardType={keyboardType}
        returnKeyType="done"
        onSubmitEditing={handleSubmit}
      />

      <View style={styles.actions}>
        <Pressable
          style={({ pressed }) => [styles.cancelButton, pressed && styles.buttonPressed]}
          onPress={onCancel}
        >
          <Text style={styles.cancelText}>{t('common.cancel', 'Cancel')}</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            styles.submitButton,
            pressed && styles.buttonPressed,
            !canSubmit && styles.submitButtonDisabled
          ]}
          disabled={!canSubmit}
          onPress={handleSubmit}
        >
          <Text style={styles.submitText}>{submitLabel ?? t('common.save', 'Save')}</Text>
        </Pressable>
      </View>
    </BottomDrawer>
  )
}

const styles = themedStyleSheet(() => ({
  header: {
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary
  },
  message: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 2
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.md
  },
  cancelButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.button
  },
  submitButton: {
    backgroundColor: colors.textPrimary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.button
  },
  buttonPressed: {
    opacity: 0.7
  },
  submitButtonDisabled: {
    opacity: 0.4
  },
  cancelText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  },
  submitText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '600'
  }
}))
