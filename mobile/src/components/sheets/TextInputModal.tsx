import { useState } from 'react'
import { Text, View, type KeyboardTypeOptions } from 'react-native'
import type { LucideIcon } from 'lucide-react-native'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { SettingsNote, settingsScreenStylesSheet } from '../../settings/settings-screen-frame'
import { BottomDrawer } from '../bottom-drawer/BottomDrawer'
import { TextField } from '../composer-input/TextField'
import { groupFieldStylesSheet } from '../composer-input/composer-input-styles'
import { SheetHeader } from '../nav-bar/SheetHeader'

type SheetProps = {
  title: string
  /** What the text is for, e.g. the item being renamed; one line under the title. */
  subtitle?: string
  /** A hint under the field. */
  message?: string
  value: string
  onChangeText: (value: string) => void
  placeholder?: string
  submitLabel?: string
  /** The back-out's label, when "Cancel" would read as the submit itself. */
  cancelLabel?: string
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
  subtitle,
  message,
  value,
  onChangeText,
  placeholder,
  submitLabel,
  cancelLabel,
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
  const groupFieldStyles = useThemedStyles(groupFieldStylesSheet)
  const styles = useThemedStyles(stylesSheet)
  const settingsScreenStyles = useThemedStyles(settingsScreenStylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()

  const filled = !submitBlocked && (allowEmpty || value.trim().length > 0)
  const canSubmit = !busy && filled
  const NoticeIcon = notice?.icon

  function handleSubmit() {
    if (canSubmit) {
      onSubmit(value.trim())
    }
  }

  return (
    <>
      <SheetHeader
        title={title}
        {...(subtitle !== undefined ? { subtitle } : {})}
        leading={{ label: cancelLabel ?? t('common.cancel', 'Cancel'), onPress: onCancel }}
        trailing={{
          label: submitLabel ?? t('common.save', 'Save'),
          onPress: handleSubmit,
          disabled: !filled,
          busy
        }}
      />
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
        style={groupFieldStyles.underHeader}
      />
      {error ? (
        <SettingsNote error>{error}</SettingsNote>
      ) : notice && NoticeIcon ? (
        // A note with the reason's icon: Save is off or waiting until the computer is back.
        <View style={styles.notice} accessibilityRole="alert">
          <NoticeIcon size={13} color={colors.textSecondary} style={styles.noticeIcon} />
          <Text style={[settingsScreenStyles.note, styles.noticeText]}>{notice.text}</Text>
        </View>
      ) : message ? (
        <SettingsNote>{message}</SettingsNote>
      ) : null}
    </>
  )
}

const stylesSheet = themedStyleSheet(() => ({
  // The note's inset moves to the row, so the icon sits where note text starts.
  notice: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm
  },
  noticeIcon: { marginTop: 3 },
  noticeText: { flex: 1, paddingHorizontal: 0, paddingTop: 0 }
}))
