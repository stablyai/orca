import { Keyboard } from 'react-native'
import { hostOs } from './host-os.web'
import { subscribeSoftKeyboard } from './keyboard-occlusion.web'

// Chromium hides the IME to show a tapped autocorrected word's suggestion menu; that hide must keep the caret.
const FIELD_TOUCH_HIDE_WINDOW_MS = 1000
const KEYBOARD_REOPEN_DELAY_MS = 50

function isTextField(target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
}

// Android keeps the IME closed for a field that stays focused; blur then focus starts a new focus session, as for the terminal input.
function reopenKeyboard(field: Element | null): void {
  if (document.activeElement === field && isTextField(field)) {
    const { selectionStart, selectionEnd } = field
    field.blur()
    field.focus()
    if (selectionStart !== null && selectionEnd !== null) {
      field.setSelectionRange(selectionStart, selectionEnd)
    }
  }
}

// Android Back hides the IME without blurring; blur now so the next terminal touch cannot reopen it.
export function startBlurringOnKeyboardClose(): void {
  if (hostOs() === 'android') {
    let fieldTouchedAt = -Infinity
    document.addEventListener(
      'pointerdown',
      (event) => {
        fieldTouchedAt = isTextField(event.target) ? Date.now() : -Infinity
      },
      { capture: true }
    )
    subscribeSoftKeyboard(
      () => {},
      () => {
        if (Date.now() - fieldTouchedAt > FIELD_TOUCH_HIDE_WINDOW_MS) {
          Keyboard.dismiss()
        } else {
          const field = document.activeElement
          setTimeout(() => reopenKeyboard(field), KEYBOARD_REOPEN_DELAY_MS)
        }
      }
    )
  }
}
