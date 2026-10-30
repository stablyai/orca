import type { NativeSyntheticEvent, TextInputKeyPressEventData, TextInputProps } from 'react-native'
import { useSoftKeyboard } from '../../platform/keyboard-occlusion'
import { hostOs } from '../../platform/host-os'
import { showsSoftKeyboard } from '../../platform/soft-keyboard-shown'

function holdsModifierOrComposes(nativeEvent: TextInputKeyPressEventData): boolean {
  if (!(nativeEvent instanceof KeyboardEvent)) {
    return true
  }
  return (
    nativeEvent.shiftKey ||
    nativeEvent.altKey ||
    nativeEvent.ctrlKey ||
    nativeEvent.metaKey ||
    nativeEvent.isComposing ||
    nativeEvent.keyCode === 229
  )
}

// RN Web ignores submitBehavior and blurs on blurOnSubmit, so claim the keydown; Shift+Enter keeps its newline.
export function useHardwareKeyboardEnterSubmit(
  onSubmit: (() => void) | undefined
): Pick<TextInputProps, 'onKeyPress'> {
  const keyboard = useSoftKeyboard()
  if (!onSubmit || hostOs() !== 'ios' || showsSoftKeyboard(keyboard)) {
    return {}
  }
  return {
    onKeyPress: (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (event.nativeEvent.key !== 'Enter' || holdsModifierOrComposes(event.nativeEvent)) {
        return
      }
      event.preventDefault()
      onSubmit()
    }
  }
}
