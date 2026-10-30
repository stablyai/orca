import type { SoftKeyboardState } from './keyboard-occlusion'

// A hardware keyboard leaves at most iOS's shortcut bar (plus an accessory row); any real soft keyboard is taller.
const SOFT_KEYBOARD_MIN_HEIGHT = 150

export function showsSoftKeyboard(keyboard: SoftKeyboardState): boolean {
  return keyboard.visible && keyboard.height >= SOFT_KEYBOARD_MIN_HEIGHT
}
