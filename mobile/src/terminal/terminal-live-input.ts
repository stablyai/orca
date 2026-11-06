import { buildTerminalShortcutKey } from './terminal-accessory-keys'

const TERMINAL_LIVE_INPUT_MAX_BYTES = 256 * 1024

const encoder = new TextEncoder()

type TerminalLiveSpecialKeyId =
  | 'arrowDown'
  | 'arrowLeft'
  | 'arrowRight'
  | 'arrowUp'
  | 'backspace'
  | 'delete'
  | 'end'
  | 'escape'
  | 'f1'
  | 'f2'
  | 'f3'
  | 'f4'
  | 'f5'
  | 'f6'
  | 'f7'
  | 'f8'
  | 'f9'
  | 'f10'
  | 'f11'
  | 'f12'
  | 'home'
  | 'insert'
  | 'pageDown'
  | 'pageUp'
  | 'tab'

// Keep Enter on onSubmitEditing; handling both native key and submit events would double-send Return.
const TERMINAL_LIVE_SPECIAL_KEY_IDS = new Map<string, TerminalLiveSpecialKeyId>([
  ['Escape', 'escape'],
  ['Esc', 'escape'],
  ['Tab', 'tab'],
  ['Backspace', 'backspace'],
  ['Delete', 'delete'],
  ['Insert', 'insert'],
  ['ArrowUp', 'arrowUp'],
  ['ArrowDown', 'arrowDown'],
  ['ArrowLeft', 'arrowLeft'],
  ['ArrowRight', 'arrowRight'],
  ['Home', 'home'],
  ['End', 'end'],
  ['PageUp', 'pageUp'],
  ['PageDown', 'pageDown'],
  ['F1', 'f1'],
  ['F2', 'f2'],
  ['F3', 'f3'],
  ['F4', 'f4'],
  ['F5', 'f5'],
  ['F6', 'f6'],
  ['F7', 'f7'],
  ['F8', 'f8'],
  ['F9', 'f9'],
  ['F10', 'f10'],
  ['F11', 'f11'],
  ['F12', 'f12']
])

export type TerminalLiveInputFocusTimerRef = {
  current: ReturnType<typeof setTimeout> | null
}

export type TerminalLiveInputFocusTarget = {
  readonly focus: () => void
  readonly blur: () => void
  readonly isFocused?: () => boolean
}

type FocusTerminalLiveInputTargetOptions = {
  readonly keyboardHeight: number
  readonly refocus: () => void
  readonly reopenFocusedInputWhenKeyboardHidden: boolean
}

export function getTerminalLiveSpecialKeyId(key: string): TerminalLiveSpecialKeyId | null {
  return TERMINAL_LIVE_SPECIAL_KEY_IDS.get(key) ?? null
}

export function getTerminalLiveSpecialKeyBytes(key: string): string | null {
  const shortcutKey = getTerminalLiveSpecialKeyId(key)
  if (!shortcutKey) {
    return null
  }
  return buildTerminalShortcutKey({ key: shortcutKey, modifiers: [] })?.bytes ?? null
}

export function isTerminalLiveInputWithinByteLimit(
  text: string,
  maxBytes = TERMINAL_LIVE_INPUT_MAX_BYTES
): boolean {
  return encoder.encode(text).byteLength <= maxBytes
}

export function clearTerminalLiveInputFocusTimer(timerRef: TerminalLiveInputFocusTimerRef): void {
  if (timerRef.current === null) {
    return
  }
  clearTimeout(timerRef.current)
  timerRef.current = null
}

export function scheduleTerminalLiveInputFocus(
  timerRef: TerminalLiveInputFocusTimerRef,
  focus: () => void,
  delayMs = 50
): void {
  // Replace pending focus timers so route changes cannot focus a stale input after disable/unmount.
  clearTerminalLiveInputFocusTimer(timerRef)
  timerRef.current = setTimeout(() => {
    timerRef.current = null
    focus()
  }, delayMs)
}

export function focusTerminalLiveInputTarget(
  input: TerminalLiveInputFocusTarget | null,
  {
    keyboardHeight,
    refocus,
    reopenFocusedInputWhenKeyboardHidden
  }: FocusTerminalLiveInputTargetOptions
): void {
  if (!input) {
    return
  }

  if (reopenFocusedInputWhenKeyboardHidden && keyboardHeight <= 0 && input.isFocused?.()) {
    // Android can retain hidden input focus after IME dismissal; blur first to create a new focus session.
    input.blur()
    refocus()
    return
  }

  input.focus()
}

export { TERMINAL_LIVE_INPUT_MAX_BYTES }
