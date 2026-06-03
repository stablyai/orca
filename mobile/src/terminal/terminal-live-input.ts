const TERMINAL_LIVE_INPUT_MAX_BYTES = 256 * 1024

const encoder = new TextEncoder()

export type TerminalLiveInputFocusTimerRef = {
  current: ReturnType<typeof setTimeout> | null
}

export function getTerminalLiveSpecialKeyBytes(key: string): string | null {
  if (key === 'Backspace') {
    return '\x7f'
  }
  return null
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
  // Why: live input can be toggled during route changes; replacing the pending
  // focus timer prevents stale native TextInput focus after unmount/disable.
  clearTerminalLiveInputFocusTimer(timerRef)
  timerRef.current = setTimeout(() => {
    timerRef.current = null
    focus()
  }, delayMs)
}

export { TERMINAL_LIVE_INPUT_MAX_BYTES }
