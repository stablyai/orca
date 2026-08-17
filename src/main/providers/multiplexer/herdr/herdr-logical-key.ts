const C0_KEYS: Readonly<Record<string, string>> = {
  '\x03': 'ctrl+c',
  '\x04': 'ctrl+d',
  '\x08': 'backspace',
  '\t': 'tab',
  '\x0c': 'ctrl+l',
  '\r': 'enter',
  '\x1a': 'ctrl+z',
  '\x1b': 'esc',
  '\x1c': 'ctrl+\\',
  '\x7f': 'backspace'
}

const KITTY_FUNCTION_KEYS: Readonly<Record<number, string>> = {
  9: 'tab',
  13: 'enter',
  27: 'esc',
  127: 'backspace'
}

const KITTY_CSI_U = new RegExp(`^${String.fromCharCode(27)}\\[(\\d+)(?:;(\\d+)(?:;(\\d+))?)?u$`)

// Kitty modifier field is 1 + bit flags. Ctrl is bit 2 (value 4).
const KITTY_CTRL_BIT = 4
const KITTY_EVENT_RELEASE = 3

export function herdrLogicalKeyForBytes(data: string): string | null {
  if (data.length === 1) {
    return C0_KEYS[data] ?? null
  }
  const match = KITTY_CSI_U.exec(data)
  if (!match) {
    return null
  }
  const code = Number(match[1])
  const modifier = match[2] === undefined ? 1 : Number(match[2])
  const eventType = match[3] === undefined ? 1 : Number(match[3])
  if (eventType === KITTY_EVENT_RELEASE) {
    return null
  }
  const functionKey = KITTY_FUNCTION_KEYS[code]
  if (functionKey && ((modifier - 1) & KITTY_CTRL_BIT) === 0) {
    return functionKey
  }
  if (((modifier - 1) & KITTY_CTRL_BIT) !== 0 && code >= 97 && code <= 122) {
    return `ctrl+${String.fromCharCode(code)}`
  }
  if (((modifier - 1) & KITTY_CTRL_BIT) !== 0 && code === 92) {
    return 'ctrl+\\'
  }
  return null
}
