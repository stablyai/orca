import { useState } from 'react'
import { BottomDrawer } from '../bottom-drawer/BottomDrawer'
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
