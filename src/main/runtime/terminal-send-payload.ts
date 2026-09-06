import {
  isTerminalInputTooLargeWithYield,
  TERMINAL_INPUT_TOO_LARGE_ERROR
} from '../../shared/terminal-input'

export function buildTerminalSendPayload(action: {
  text?: string
  enter?: boolean
  interrupt?: boolean
}): string | null {
  let payload = ''
  if (typeof action.text === 'string' && action.text.length > 0) {
    payload += action.text
  }
  if (action.enter) {
    payload += '\r'
  }
  if (action.interrupt) {
    payload += '\x03'
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
