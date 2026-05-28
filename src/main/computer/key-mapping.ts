import { RuntimeClientError } from './runtime-client-error'

export type KeyChord = {
  key: string
  modifiers: string[]
}

const MODIFIER_NAMES: Record<string, string> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  meta: 'Meta',
  super: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  win: 'Meta'
}

const PLATFORM_MODIFIER_NAMES: Record<string, () => string> = {
  cmdorctrl: () => (process.platform === 'darwin' ? 'Meta' : 'Ctrl'),
  commandorcontrol: () => (process.platform === 'darwin' ? 'Meta' : 'Ctrl')
}

const KEY_NAMES: Record<string, string> = {
  Return: 'Enter',
  Enter: 'Enter',
  Escape: 'Escape',
  Esc: 'Escape',
  BackSpace: 'Backspace',
  Backspace: 'Backspace',
  Tab: 'Tab',
  space: 'Space',
  Space: 'Space',
  Page_Up: 'PageUp',
  Page_Down: 'PageDown',
  Home: 'Home',
  End: 'End',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Delete: 'Delete',
  Insert: 'Insert',
  KP_Add: 'NumpadAdd',
  KP_Subtract: 'NumpadSubtract',
  KP_Multiply: 'NumpadMultiply',
  KP_Divide: 'NumpadDivide',
  KP_Enter: 'NumpadEnter'
}

export function parseKey(input: string): KeyChord {
  const parts = input
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) {
    throw new RuntimeClientError('invalid_argument', 'key must not be empty')
  }

  const keyPart = parts.at(-1)!
  const modifiers = parts.slice(0, -1).map(parseModifier)
  return {
    key: parseBaseKey(keyPart),
    modifiers: dedupeModifiers(modifiers)
  }
}

function parseModifier(input: string): string {
  const platformModifier = PLATFORM_MODIFIER_NAMES[input.toLowerCase()]
  if (platformModifier) {
    return platformModifier()
  }
  const modifier = MODIFIER_NAMES[input.toLowerCase()]
  if (!modifier) {
    throw new RuntimeClientError('invalid_argument', `unknown modifier '${input}'`)
  }
  return modifier
}

function parseBaseKey(input: string): string {
  const mapped = KEY_NAMES[input]
  if (mapped) {
    return mapped
  }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(input)) {
    return input
  }
  const keypadDigit = input.match(/^KP_([0-9])$/)
  if (keypadDigit) {
    return `Numpad${keypadDigit[1]}`
  }
  if (isPrintableAscii(input)) {
    return input
  }
  throw new RuntimeClientError('invalid_argument', `unknown key '${input}'`)
}

function isPrintableAscii(input: string): boolean {
  if (input.length !== 1) {
    return false
  }
  const code = input.charCodeAt(0)
  return code >= 0x20 && code <= 0x7e
}

function dedupeModifiers(modifiers: string[]): string[] {
  return [...new Set(modifiers)]
}
