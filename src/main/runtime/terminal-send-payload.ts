import {
  isTerminalInputTooLargeWithYield,
  TERMINAL_INPUT_TOO_LARGE_ERROR
} from '../../shared/terminal-input'
import { terminalInterruptBytes } from '../../shared/terminal-interrupt-bytes'

/** Builds terminal.send bytes using the PTY's current kitty flags for Ctrl+C. */
export function buildTerminalSendPayload(
  action: {
    text?: string
    enter?: boolean
    interrupt?: boolean
  },
  kittyKeyboardFlags = 0
): string | null {
  let payload = ''
  if (typeof action.text === 'string' && action.text.length > 0) {
    payload += action.text
  }
  if (action.enter) {
    payload += '\r'
  }
  if (action.interrupt) {
    payload += terminalInterruptBytes(kittyKeyboardFlags)
  }
  return payload.length > 0 ? payload : null
}

export async function assertTerminalInputWithinLimitWithYield(
  text: string | undefined
): Promise<void> {
  if (text && (await isTerminalInputTooLargeWithYield(text))) {
    throw new Error(TERMINAL_INPUT_TOO_LARGE_ERROR)
  }
}
