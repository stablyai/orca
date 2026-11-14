import { useState } from 'react'
import { ActivityIndicator, View, Text, Pressable, type KeyboardTypeOptions } from 'react-native'
import type { LucideIcon } from 'lucide-react-native'
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
  /** Why Save is off or still waiting (e.g. the desktop is offline); shown under the field. */
  notice?: { icon: LucideIcon; text: string } | null
  /** Save is off for a reason the notice gives; the text stays editable. */
  submitBlocked?: boolean
  onSubmit: (value: string) => void
  onCancel: () => void
}

type Props = Omit<
  SheetProps,
  'value' | 'onChangeText' | 'error' | 'busy' | 'notice' | 'submitBlocked'
> & {
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
  notice,
  submitBlocked = false,
  onSubmit,
  onCancel
}: SheetProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()

  const canSubmit = !busy && !submitBlocked && (allowEmpty || value.trim().length > 0)
  const NoticeIcon = notice?.icon

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

      {error ? (
        <Text style={styles.error}>{error}</Text>
      ) : notice && NoticeIcon ? (
        <View style={styles.notice}>
          <NoticeIcon size={13} color={colors.textSecondary} style={styles.noticeIcon} />
          <Text style={styles.noticeText}>{notice.text}</Text>
        </View>
      ) : null}

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
          {busy ? (
            <ActivityIndicator size="small" color={colors.bgBase} style={styles.submitSpinner} />
          ) : null}
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
  notice: {
    flexDirection: 'row',
    gap: 6,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.xs
  },
  noticeIcon: {
    marginTop: 2
  },
  noticeText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    lineHeight: 17
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.textPrimary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.control
  },
  buttonPressed: {
    opacity: 0.7
  },
  // Keeps the button's height while it spins.
  submitSpinner: {
    width: 14,
    height: 14,
    transform: [{ scale: 0.7 }]
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
