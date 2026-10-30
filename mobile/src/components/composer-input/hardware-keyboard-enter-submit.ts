import type { TextInputProps } from 'react-native'
import { useSoftKeyboard } from '../../platform/keyboard-occlusion'
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
  return showsSoftKeyboard(keyboard)
    ? { submitBehavior: 'newline' }
    : { submitBehavior: 'submit', onSubmitEditing: onSubmit }
}
