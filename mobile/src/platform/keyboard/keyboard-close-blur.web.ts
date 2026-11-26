import { Keyboard } from 'react-native'
import { hostOs } from '../host-os.web'
import { subscribeSoftKeyboard } from './keyboard-occlusion.web'

// Chromium hides the IME itself to show a tapped autocorrected word's menu; Back comes with no touch.
const FIELD_TAP_HIDE_WINDOW_MS = 1000
const KEYBOARD_REOPEN_DELAY_MS = 50
// A keyboard's mic switches to a voice IME, which closes the keyboard and opens again ~250 ms later; Back opens none.
const IME_SWITCH_WINDOW_MS = 1000
// A hardware keystroke closes the IME (Gboard hides itself); the close reaches the page a few hundred ms later.
const HARDWARE_KEY_CLOSE_WINDOW_MS = 1000

// Android raises the IME only for a new focus session, as for the terminal live input.
function reopenKeyboard(field: HTMLElement): void {
  if (document.activeElement === field) {
    field.blur()
    field.focus()
  }
}

// Android Back hides the IME without blurring; blur once it stays closed so the next terminal touch cannot reopen it.
export function startBlurringOnKeyboardClose(): void {
  if (hostOs() !== 'android') {
    return
  }
  let lastTouch: { target: Node; at: number } | null = null
  let pendingBlur: ReturnType<typeof setTimeout> | undefined
  let lastKeyAt = Number.NEGATIVE_INFINITY
  let lastPhysicalKeyAt = Number.NEGATIVE_INFINITY
  document.addEventListener(
    'pointerdown',
    (event) => {
      lastTouch =
        event.target instanceof Node ? { target: event.target, at: performance.now() } : null
    },
    { capture: true }
  )
  document.addEventListener(
    'keydown',
    (event) => {
      lastKeyAt = performance.now()
      // Only a physical key has a code; soft keyboards type through the IME as keyCode 229 with none.
      if (event.code !== '') {
        lastPhysicalKeyAt = lastKeyAt
      }
    },
    { capture: true }
  )
  subscribeSoftKeyboard(
    () => clearTimeout(pendingBlur),
    () => {
      const closedAt = performance.now()
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
        // Leave alone a field focus moved to meanwhile.
        pendingBlur = setTimeout(() => {
          // Back sends the page no key; a physical key just before the close, or any key after it (the IME relays
          // hardware keys while composing), is a hardware keyboard still typing.
          const hardwareTyping =
            lastPhysicalKeyAt >= closedAt - HARDWARE_KEY_CLOSE_WINDOW_MS || lastKeyAt > closedAt
          if (document.activeElement === field && !hardwareTyping) {
            Keyboard.dismiss()
          }
        }, IME_SWITCH_WINDOW_MS)
      }
    }
  )
}
