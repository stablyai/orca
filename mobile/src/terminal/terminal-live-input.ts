const TERMINAL_LIVE_INPUT_MAX_BYTES = 256 * 1024

const encoder = new TextEncoder()

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

export { TERMINAL_LIVE_INPUT_MAX_BYTES }
