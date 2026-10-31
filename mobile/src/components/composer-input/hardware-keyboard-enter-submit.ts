import type { TextInputProps } from 'react-native'
import { currentSoftKeyboardHeight, useSoftKeyboard } from '../../platform/keyboard-occlusion'
import { hostOs } from '../../platform/host-os'
import { showsSoftKeyboard } from '../../platform/soft-keyboard-shown'

type EnterSubmitProps = Pick<TextInputProps, 'submitBehavior' | 'onSubmitEditing'>

// iOS reports no modifiers or key source, so Return sends only while no soft keyboard is up; on-screen Return keeps its newline.
export function useHardwareKeyboardEnterSubmit(
  onSubmit: (() => void) | undefined
): EnterSubmitProps {
  const keyboard = useSoftKeyboard()
  if (!onSubmit || hostOs() !== 'ios') {
    return {}
  }
  // A composer mounted under an open keyboard gets no show event until the next change, so seed from metrics.
  const seeded = keyboard.visible
    ? keyboard
    : { height: currentSoftKeyboardHeight(), visible: true }
  return showsSoftKeyboard(seeded)
    ? { submitBehavior: 'newline' }
    : { submitBehavior: 'submit', onSubmitEditing: onSubmit }
}
