import { useState } from 'react'
import { View, StyleSheet, type KeyboardTypeOptions } from 'react-native'
import { spacing } from '../theme/mobile-theme'
import { BottomDrawer } from './BottomDrawer'
import { SheetHeader } from './ui/SheetHeader'
import { TextField } from './ui/TextField'

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
  submitLabel = 'Save',
  selectTextOnFocus = false,
  allowEmpty = false,
  keyboardType,
  onSubmit,
  onCancel,
  onAfterClose
}: Props) {
  const [value, setValue] = useState(defaultValue)
  const [previousVisible, setPreviousVisible] = useState(visible)
  const [previousDefaultValue, setPreviousDefaultValue] = useState(defaultValue)

  // Why: reset before the opening commit so the drawer never paints the
  // previous modal value while preserving the existing close animation state.
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
        <SheetHeader
          title={title}
          leading={{ label: 'Cancel', onPress: onCancel }}
          trailing={{ label: submitLabel, onPress: handleSubmit, disabled: !canSubmit }}
        />
      </View>
      <View style={styles.field}>
        <TextField
          value={value}
          onChangeText={setValue}
          placeholder={placeholder}
          accessibilityLabel={title}
          footnote={message}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          selectTextOnFocus={selectTextOnFocus}
          keyboardType={keyboardType}
          returnKeyType="done"
          onSubmitEditing={handleSubmit}
        />
      </View>
    </BottomDrawer>
  )
}

const styles = StyleSheet.create({
  // Why: pulls the header's text actions out to the sheet edge, as the shared sheet spec lays them.
  header: { marginHorizontal: -spacing.sm, marginTop: -spacing.xs },
  field: { paddingHorizontal: spacing.xs, paddingTop: spacing.xs, paddingBottom: spacing.sm }
})
