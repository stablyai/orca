export type CdpKeypressDefinition = {
  key: string
  code: string
  windowsVirtualKeyCode?: number
  text?: string
  modifiers?: number
}

const KEY_DEFINITIONS: Record<string, CdpKeypressDefinition> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' }
}

function parseSerializedKey(serializedKey: string): { key: string; modifiers: number } {
  const parts: string[] = []
  let key = serializedKey
  for (;;) {
    const match = /^(Alt|Control|Meta|Shift)\+/.exec(key)
    if (!match) {
      break
    }
    parts.push(match[1])
    key = key.slice(match[0].length)
  }
  const modifiers = parts.reduce((mask, part) => {
    if (part === 'Alt') {
      return mask | 1
    }
    if (part === 'Control') {
      return mask | 2
    }
    if (part === 'Meta') {
      return mask | 4
    }
    if (part === 'Shift') {
      return mask | 8
    }
    return mask
  }, 0)
  return { key, modifiers }
}

function baseKeyDefinition(key: string): CdpKeypressDefinition {
  if (KEY_DEFINITIONS[key]) {
    return KEY_DEFINITIONS[key]
  }
  if (key.length === 1) {
    const charCode = key.charCodeAt(0)
    if (charCode >= 48 && charCode <= 57) {
      return { key, code: `Digit${key}`, windowsVirtualKeyCode: charCode, text: key }
    }
    if ((charCode >= 65 && charCode <= 90) || (charCode >= 97 && charCode <= 122)) {
      return {
        key,
        code: `Key${key.toUpperCase()}`,
        windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
        text: key
      }
    }
    return { key, code: '', windowsVirtualKeyCode: charCode, text: key }
  }
  return { key, code: key }
}

export function resolveCdpKeypressDefinition(serializedKey: string): CdpKeypressDefinition {
  const { key, modifiers } = parseSerializedKey(serializedKey)
  const definition = baseKeyDefinition(key)
  const hasCommandModifier = (modifiers & 0b0111) !== 0
  const shiftedNonPrintable = modifiers === 0b1000 && definition.key.length !== 1
  return {
    ...definition,
    ...(modifiers ? { modifiers } : {}),
    ...(hasCommandModifier || shiftedNonPrintable ? { text: undefined } : {})
  }
}
