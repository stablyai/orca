import { hostOs } from '../platform/host-os'

/** Android keeps a hidden TextInput focused after Back closes the IME, so focus must blur first. */
export function reopensFocusedInputWhenKeyboardHidden(): boolean {
  return hostOs() === 'android'
}
