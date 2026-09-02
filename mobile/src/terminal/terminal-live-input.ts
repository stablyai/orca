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

// Why: Enter stays on onSubmitEditing; mapping it here can double-send carriage
// returns when native TextInput emits both submit and key events.
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
}

export type TerminalLiveInputDefaultResult = {
  enabledHandles: ReadonlySet<string>
  defaultedHandles: ReadonlySet<string>
  changed: boolean
}

export type TerminalLiveInputPruneResult = TerminalLiveInputDefaultResult

export function getTerminalLiveSpecialKeyBytes(key: string): string | null {
  const shortcutKey = TERMINAL_LIVE_SPECIAL_KEY_IDS.get(key)
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

export function defaultTerminalLiveInputHandles(
  enabledHandles: ReadonlySet<string>,
  defaultedHandles: ReadonlySet<string>,
  terminalHandles: readonly string[]
): TerminalLiveInputDefaultResult {
  let nextEnabledHandles: Set<string> | null = null
  let nextDefaultedHandles: Set<string> | null = null

  for (const handle of terminalHandles) {
    if (defaultedHandles.has(handle)) {
      continue
    }
    nextEnabledHandles ??= new Set(enabledHandles)
    nextDefaultedHandles ??= new Set(defaultedHandles)
    nextEnabledHandles.add(handle)
    nextDefaultedHandles.add(handle)
  }

  if (!nextEnabledHandles || !nextDefaultedHandles) {
    return { enabledHandles, defaultedHandles, changed: false }
  }

  return {
    enabledHandles: nextEnabledHandles,
    defaultedHandles: nextDefaultedHandles,
    changed: true
  }
}

export function filterTerminalLiveInputDefaultCandidates(
  terminalHandles: readonly string[],
  disabledHandles: ReadonlySet<string>
): string[] {
  return terminalHandles.filter((handle) => !disabledHandles.has(handle))
}

export function applyDisabledTerminalLiveInputHandles(
  enabledHandles: ReadonlySet<string>,
  defaultedHandles: ReadonlySet<string>,
  disabledHandles: ReadonlySet<string>
): TerminalLiveInputDefaultResult {
  let nextEnabledHandles: Set<string> | null = null
  let nextDefaultedHandles: Set<string> | null = null

  for (const handle of enabledHandles) {
    if (!disabledHandles.has(handle)) {
      continue
    }
    nextEnabledHandles ??= new Set(enabledHandles)
    nextEnabledHandles.delete(handle)
  }

  for (const handle of disabledHandles) {
    if (defaultedHandles.has(handle)) {
      continue
    }
    nextDefaultedHandles ??= new Set(defaultedHandles)
    nextDefaultedHandles.add(handle)
  }

  if (!nextEnabledHandles && !nextDefaultedHandles) {
    return { enabledHandles, defaultedHandles, changed: false }
  }

  return {
    enabledHandles: nextEnabledHandles ?? enabledHandles,
    defaultedHandles: nextDefaultedHandles ?? defaultedHandles,
    changed: true
  }
}

export function pruneTerminalLiveInputHandles(
  enabledHandles: ReadonlySet<string>,
  defaultedHandles: ReadonlySet<string>,
  liveTerminalHandles: ReadonlySet<string>
): TerminalLiveInputPruneResult {
  let nextEnabledHandles: Set<string> | null = null
  let nextDefaultedHandles: Set<string> | null = null

  for (const handle of enabledHandles) {
    if (liveTerminalHandles.has(handle)) {
      continue
    }
    nextEnabledHandles ??= new Set(enabledHandles)
    nextEnabledHandles.delete(handle)
  }

  for (const handle of defaultedHandles) {
    if (liveTerminalHandles.has(handle)) {
      continue
    }
    nextDefaultedHandles ??= new Set(defaultedHandles)
    nextDefaultedHandles.delete(handle)
  }

  if (!nextEnabledHandles && !nextDefaultedHandles) {
    return { enabledHandles, defaultedHandles, changed: false }
  }

  return {
    enabledHandles: nextEnabledHandles ?? enabledHandles,
    defaultedHandles: nextDefaultedHandles ?? defaultedHandles,
    changed: true
  }
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
  // Why: live input can be toggled during route changes; replacing the pending
  // focus timer prevents stale native TextInput focus after unmount/disable.
  clearTerminalLiveInputFocusTimer(timerRef)
  timerRef.current = setTimeout(() => {
    timerRef.current = null
    focus()
  }, delayMs)
}

export function focusTerminalLiveInputTarget(
  input: TerminalLiveInputFocusTarget | null,
  { keyboardHeight, refocus }: FocusTerminalLiveInputTargetOptions
): void {
  if (!input) {
    return
  }

  if (keyboardHeight <= 0 && input.isFocused?.()) {
    // Why: Android can keep a hidden TextInput focused after the IME is dismissed;
    // focus() is then a no-op, so force a new focus session to reopen the keyboard.
    input.blur()
    refocus()
    return
  }

  input.focus()
}

export { TERMINAL_LIVE_INPUT_MAX_BYTES }
