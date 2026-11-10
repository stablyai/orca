import { Keyboard } from 'react-native'
import { hostOs } from './host-os.web'
import { subscribeSoftKeyboard } from './keyboard-occlusion.web'

// Chromium hides the IME itself to show a tapped autocorrected word's menu; Back comes with no touch.
const FIELD_TAP_HIDE_WINDOW_MS = 1000
const KEYBOARD_REOPEN_DELAY_MS = 50

// Android raises the IME only for a new focus session, as for the terminal live input.
function reopenKeyboard(field: HTMLElement): void {
  if (document.activeElement === field) {
    field.blur()
    field.focus()
  }
}

// Android Back hides the IME without blurring; blur now so the next terminal touch cannot reopen it.
export function startBlurringOnKeyboardClose(): void {
  if (hostOs() !== 'android') {
    return
  }
  let lastTouch: { target: Node; at: number } | null = null
  document.addEventListener(
    'pointerdown',
    (event) => {
      lastTouch =
        event.target instanceof Node ? { target: event.target, at: performance.now() } : null
    },
    { capture: true }
  )
  subscribeSoftKeyboard(
    () => {},
    () => {
      const field = document.activeElement
      const touch = lastTouch
      lastTouch = null
      if (
        field instanceof HTMLElement &&
        touch !== null &&
        field.contains(touch.target) &&
        performance.now() - touch.at <= FIELD_TAP_HIDE_WINDOW_MS
      ) {
        setTimeout(() => reopenKeyboard(field), KEYBOARD_REOPEN_DELAY_MS)
      } else {
        Keyboard.dismiss()
      }
    }
  )
}
