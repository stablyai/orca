import { Keyboard } from 'react-native'
import { hostOs } from './host-os.web'
import { subscribeSoftKeyboard } from './keyboard-occlusion.web'

/**
 * Android's Back closes the keyboard but leaves its field focused, and the WebView raises the
 * keyboard again for a focused field on the next terminal touch. Ending the focus with the keyboard
 * keeps a closed keyboard closed until something focuses a field, as on iOS.
 */
export function startBlurringOnKeyboardClose(): void {
  if (hostOs() === 'android') {
    subscribeSoftKeyboard(
      () => {},
      () => Keyboard.dismiss()
    )
  }
}
