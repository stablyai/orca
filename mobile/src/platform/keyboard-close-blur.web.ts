import { Keyboard } from 'react-native'
import { hostOs } from './host-os.web'
import { subscribeSoftKeyboard } from './keyboard-occlusion.web'

// Android Back hides the IME without blurring; blur now so the next terminal touch cannot reopen it.
export function startBlurringOnKeyboardClose(): void {
  if (hostOs() === 'android') {
    subscribeSoftKeyboard(
      () => {},
      () => Keyboard.dismiss()
    )
  }
}
