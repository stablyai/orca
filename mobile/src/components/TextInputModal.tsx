import { useState } from 'react'
import { View, Text, Pressable, type KeyboardTypeOptions } from 'react-native'
import { colors, spacing, radii, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { BottomDrawer } from './bottom-drawer/BottomDrawer'
import { TextField } from './composer-input/TextField'

type SheetProps = {
  title: string
  message?: string
  value: string
  onChangeText: (value: string) => void
  placeholder?: string
  submitLabel?: string
  selectTextOnFocus?: boolean
  allowEmpty?: boolean
  keyboardType?: KeyboardTypeOptions
  /** Shown under the field; the text stays so the user can retry. */
  error?: string | null
  /** A save in flight: Save is disabled so it can't be sent twice. */
  busy?: boolean
  onSubmit: (value: string) => void
  onCancel: () => void
}

type Props = Omit<SheetProps, 'value' | 'onChangeText' | 'error' | 'busy'> & {
  visible: boolean
  defaultValue?: string
  /** Called once the drawer has gone, which is when the field stops holding the focus. */
  onAfterClose?: () => void
}

export function TextInputModal({
  visible,
  defaultValue = '',
  onCancel,
  onAfterClose,
  ...sheetProps
}: Props) {
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

  return (
    <BottomDrawer visible={visible} onClose={onCancel} onAfterClose={onAfterClose}>
      <TextInputSheetContent
        {...sheetProps}
        value={value}
        onChangeText={setValue}
        onCancel={onCancel}
      />
    </BottomDrawer>
  )
}

/** The text sheet's body, for a drawer that is already open (e.g. a menu that swaps to it). */
export function TextInputSheetContent({
  title,
  message,
  value,
  onChangeText,
  placeholder,
  submitLabel,
  selectTextOnFocus = false,
  allowEmpty = false,
  keyboardType,
  error,
  busy = false,
  onSubmit,
  onCancel
}: SheetProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()

  const canSubmit = !busy && (allowEmpty || value.trim().length > 0)

  function handleSubmit() {
    if (canSubmit) {
      onSubmit(value.trim())
    }
  }

  return (
    <>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        {message ? <Text style={styles.message}>{message}</Text> : null}
      </View>

      <TextField
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        selectTextOnFocus={selectTextOnFocus}
        keyboardType={keyboardType}
        returnKeyType="done"
        onSubmitEditing={handleSubmit}
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

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
    </>
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
  error: {
    color: colors.statusRed,
    fontSize: typography.metaSize,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.xs
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
    borderRadius: radii.control
  },
  submitButton: {
    backgroundColor: colors.textPrimary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.control
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
