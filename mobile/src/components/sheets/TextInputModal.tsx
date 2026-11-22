import { useState } from 'react'
import { BottomDrawer } from '../bottom-drawer/BottomDrawer'
import { useShellDialog } from '../../platform/page-dialogs/use-shell-dialog'
import { TextInputSheetContent, type TextInputModalProps } from './TextInputSheetContent'

export { TextInputSheetContent }
export type { TextInputModalProps }

export function TextInputModal({
  visible,
  defaultValue = '',
  onCancel,
  onAfterClose,
  ...sheetProps
}: TextInputModalProps) {
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

  const native = useShellDialog({
    visible,
    request: {
      action: 'prompt',
      title: sheetProps.title,
      message: sheetProps.message,
      defaultValue,
      placeholder: sheetProps.placeholder,
      submitLabel: sheetProps.submitLabel,
      cancelLabel: sheetProps.cancelLabel,
      selectTextOnFocus: sheetProps.selectTextOnFocus === true,
      allowEmpty: sheetProps.allowEmpty === true,
      keyboardType: sheetProps.keyboardType
    },
    onAnswer: ({ outcome, value }) => {
      if (outcome === 'confirm' && value !== null) {
        sheetProps.onSubmit(value)
      } else {
        onCancel()
      }
      onAfterClose?.()
    },
    onWithdrawn: onAfterClose
  })
  if (native) {
    return null
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
